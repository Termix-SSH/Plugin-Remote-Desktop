//! RemoteApp (RAIL). A trimmed port of IronRDP's desktop client RailClient:
//! after the server's handshake it sends the client setup and asks the
//! server to start one program. Window orders are ignored, like guacd: the
//! app windows still arrive as ordinary graphics on the session surface.

use ironrdp_core::{decode, impl_as_any};
use ironrdp::pdu::gcc::{ChannelName, ChannelOptions};
use ironrdp::pdu::{decode_err, PduResult};
use ironrdp_rail::pdu::{
    ClientStatusPdu, ClientSystemParameter, ClientSystemParametersPdu, ExecutePdu, ExecuteResult, HandshakePdu,
    RailPdu, SystemParameterRectangle,
};
use ironrdp_svc::{ChannelFlags, SvcClientProcessor, SvcMessage, SvcProcessor};

#[derive(Debug)]
pub struct RailApp {
    execute: ExecutePdu,
    width: u16,
    height: u16,
    started: bool,
    /// Set when the server refuses to start the program.
    pub failure: Option<String>,
}

impl RailApp {
    pub fn new(program: String, working_directory: String, arguments: String, width: u16, height: u16) -> Self {
        Self {
            execute: ExecutePdu {
                flags: ExecutePdu::EXPAND_WORKING_DIRECTORY | ExecutePdu::EXPAND_ARGUMENTS,
                executable: program,
                working_directory,
                arguments,
            },
            width,
            height,
            started: false,
            failure: None,
        }
    }

    fn message(pdu: RailPdu) -> SvcMessage {
        SvcMessage::from(pdu).with_flags(ChannelFlags::SHOW_PROTOCOL)
    }

    fn setup(&mut self) -> Vec<SvcMessage> {
        let screen = SystemParameterRectangle {
            left: 0,
            top: 0,
            right: self.width,
            bottom: self.height,
        };
        let mut messages = vec![
            Self::message(RailPdu::Handshake(HandshakePdu { build_number: 7601 })),
            Self::message(RailPdu::ClientStatus(ClientStatusPdu {
                flags: ClientStatusPdu::Z_ORDER_SYNC,
            })),
        ];
        for parameter in [
            ClientSystemParameter::DisplayChange(screen),
            ClientSystemParameter::WorkArea(screen),
            ClientSystemParameter::FullWindowDrag(false),
            ClientSystemParameter::KeyboardCues(false),
            ClientSystemParameter::KeyboardPreference(false),
            ClientSystemParameter::MouseButtonSwap(false),
        ] {
            messages.push(Self::message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter,
            })));
        }
        if !self.started {
            self.started = true;
            messages.push(Self::message(RailPdu::Execute(self.execute.clone())));
        }
        messages
    }
}

impl_as_any!(RailApp);

impl SvcClientProcessor for RailApp {}

impl SvcProcessor for RailApp {
    fn channel_name(&self) -> ChannelName {
        ChannelName::from_static(b"rail\0\0\0\0")
    }

    fn channel_options(&self) -> ChannelOptions {
        ChannelOptions::INITIALIZED | ChannelOptions::SHOW_PROTOCOL
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        let pdu = decode::<RailPdu>(payload).map_err(|error| decode_err!(error))?;
        match pdu {
            RailPdu::Handshake(_) | RailPdu::HandshakeEx(_) => Ok(self.setup()),
            RailPdu::ExecuteResult(result) if result.result != ExecuteResult::Ok => {
                self.failure = Some(format!("{:?} ({})", result.result, result.raw_result));
                Ok(Vec::new())
            }
            _ => Ok(Vec::new()),
        }
    }
}
