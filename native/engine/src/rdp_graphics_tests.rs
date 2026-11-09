use super::*;
use ironrdp_core::{decode, encode_vec};
use ironrdp_dvc::DvcProcessor;
use ironrdp_egfx::pdu::*;
use ironrdp_graphics::rdp6::{BitmapStreamEncoder, RgbChannels};
use ironrdp_pdu::{Action, geometry::ExclusiveRectangle, mcs::SendDataIndication, x224::X224};
use ironrdp_svc::StaticChannelSet;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn graphics_does_not_depend_on_display_control() {
    for enabled in [false, true] {
        let channels = dynamic_channels(enabled);
        assert!(channels.has_registered_dvc::<GraphicsPipelineClient>());
        assert_eq!(
            channels.has_registered_dvc::<DisplayControlClient>(),
            enabled
        );
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn advertises_only_decodable_non_avc_capabilities() {
    let mut gfx = GraphicsPipelineClient::new(Box::new(GraphicsHandler), None);
    let messages = gfx.start(1).unwrap();
    let encoded = encode_vec(messages[0].as_ref()).unwrap();
    let advertised: GfxPdu = decode(&encoded).unwrap();
    assert_eq!(
        advertised,
        GfxPdu::CapabilitiesAdvertise(CapabilitiesAdvertisePdu::from_typed(&[CapabilitySet::V8 {
            flags: CapabilitiesV8Flags::SMALL_CACHE
        },]))
    );
}

// Exercise the same X224 -> static channel -> DVC -> codec -> compositor ->
// DecodedImage path that the WASM RDP client uses, with actual encoded frames.
fn server_frame(payload: &[u8]) -> Vec<u8> {
    let mut channel_data = (payload.len() as u32).to_le_bytes().to_vec();
    channel_data.extend_from_slice(&3u32.to_le_bytes()); // FIRST | LAST
    channel_data.extend_from_slice(payload);
    encode_vec(&X224(SendDataIndication {
        initiator_id: 1002,
        channel_id: 1004,
        user_data: channel_data.into(),
    }))
    .unwrap()
}

fn test_stage(channels: StaticChannelSet) -> ActiveStage {
    ActiveStageBuilder {
        static_channels: channels,
        user_channel_id: 1002,
        io_channel_id: 1003,
        message_channel_id: None,
        share_id: 1,
        compression_type: None,
        enable_server_pointer: false,
        pointer_software_rendering: false,
    }
    .build()
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn planar_graphics_reaches_session_framebuffer_and_acknowledges_frame() {
    let mut channels = StaticChannelSet::new();
    channels.insert(dynamic_channels(false));
    channels.attach_channel_id(std::any::TypeId::of::<DrdynvcClient>(), 1004);
    let mut stage = test_stage(channels);
    let mut image = DecodedImage::new(super::PixelFormat::RgbA32, 4, 2);
    // DYNVC_CREATE_REQ, one-byte channel id 1, null-terminated channel name.
    let mut create = vec![0x10, 1];
    create.extend_from_slice(ironrdp_egfx::CHANNEL_NAME.as_bytes());
    create.push(0);
    let responses = stage
        .process(&mut image, Action::X224, &server_frame(&create))
        .unwrap();
    assert!(
        responses
            .iter()
            .any(|r| matches!(r, ActiveStageOutput::ResponseFrame(_)))
    );
    assert!(stage.get_dvc::<GraphicsPipelineClient>().is_some());

    let rgb: Vec<u8> = (0..8u8).flat_map(|i| [i, 100 + i, 200 + i]).collect();
    let mut encoded = vec![0; 256];
    let size = BitmapStreamEncoder::new(4, 2)
        .encode_bitmap::<RgbChannels>(&rgb, &mut encoded, true)
        .unwrap();
    encoded.truncate(size);
    let pdus = [
        GfxPdu::CapabilitiesConfirm(CapabilitiesConfirmPdu::from_typed(&CapabilitySet::V8 {
            flags: CapabilitiesV8Flags::SMALL_CACHE,
        })),
        GfxPdu::ResetGraphics(ResetGraphicsPdu {
            width: 4,
            height: 2,
            monitors: vec![],
        }),
        GfxPdu::CreateSurface(CreateSurfacePdu {
            surface_id: 1,
            width: 4,
            height: 2,
            pixel_format: ironrdp_egfx::pdu::PixelFormat::XRgb,
        }),
        GfxPdu::MapSurfaceToOutput(MapSurfaceToOutputPdu {
            surface_id: 1,
            output_origin_x: 0,
            output_origin_y: 0,
        }),
        GfxPdu::StartFrame(StartFramePdu {
            timestamp: Timestamp {
                milliseconds: 0,
                seconds: 0,
                minutes: 0,
                hours: 0,
            },
            frame_id: 7,
        }),
        GfxPdu::WireToSurface1(WireToSurface1Pdu {
            surface_id: 1,
            codec_id: Codec1Type::Planar,
            pixel_format: ironrdp_egfx::pdu::PixelFormat::XRgb,
            destination_rectangle: ExclusiveRectangle {
                left: 0,
                top: 0,
                right: 4,
                bottom: 2,
            },
            bitmap_data: encoded,
        }),
        GfxPdu::EndFrame(EndFramePdu { frame_id: 7 }),
    ];
    // DYNVC_DATA + single uncompressed ZGFX segment carrying encoded GFX PDUs.
    let mut wire = vec![0x30, 1, 0xe0, 0x04];
    for pdu in pdus {
        wire.extend_from_slice(&encode_vec(&pdu).unwrap());
    }
    let outputs = stage
        .process(&mut image, Action::X224, &server_frame(&wire))
        .unwrap();
    assert!(
        outputs
            .iter()
            .any(|r| matches!(r, ActiveStageOutput::GraphicsUpdate(_)))
    );
    assert!(
        outputs
            .iter()
            .any(|r| matches!(r, ActiveStageOutput::ResponseFrame(bytes) if !bytes.is_empty()))
    );
    let expected: Vec<u8> = rgb
        .chunks_exact(3)
        .flat_map(|p| [p[0], p[1], p[2], 255])
        .collect();
    assert_eq!(image.data(), expected);

    #[cfg(target_arch = "wasm32")]
    {
        // Exercise the actual WASM-facing RdpClient feed/event/framebuffer path.
        // The transport and authentication handshake is intentionally out of scope.
        let mut client = RdpClient::new(
            r#"{"host":"localhost","displayControl":false}"#,
            Object::new(),
        )
        .unwrap();
        let mut connector = client.build_connector();
        assert!(connector.config.support_dyn_vc_gfx_protocol);
        connector
            .static_channels
            .attach_channel_id(std::any::TypeId::of::<DrdynvcClient>(), 1004);
        client.phase = Phase::Active(Box::new(Session {
            stage: test_stage(connector.static_channels),
            image: DecodedImage::new(super::PixelFormat::RgbA32, 2, 2),
            factory: ironrdp::connector::connection_activation::ConnectionActivationFactory::new(
                connector.config,
                1003,
                1002,
            ),
            reactivation: None,
        }));
        client.feed(&server_frame(&create));
        client.take_events();
        client.feed(&server_frame(&wire));
        let events = client.take_events();
        let kinds: Vec<String> = events
            .iter()
            .map(|e| Reflect::get(&e, &"k".into()).unwrap().as_string().unwrap())
            .collect();
        assert!(!kinds.iter().any(|k| k == "error"));
        let resize = kinds.iter().position(|k| k == "resize").unwrap();
        let dirty = kinds.iter().position(|k| k == "dirty").unwrap();
        assert!(resize < dirty);
        assert_eq!((client.width(), client.height()), (4, 2));
        let Phase::Active(session) = &client.phase else {
            panic!("session closed")
        };
        assert_eq!(session.image.data(), expected);
        assert_eq!(&client.encode_png(0, 0, 4, 2)[1..4], b"PNG");
    }
}
