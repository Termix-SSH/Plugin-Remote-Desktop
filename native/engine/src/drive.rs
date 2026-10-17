//! RDPDR backend for drive and printer redirection. The protocol side is a
//! port of IronRDP's rdpdr-native nix backend; every filesystem operation is
//! a synchronous call into JS (`fs_*` on the host object), which keeps all
//! paths inside the user's drive folder. Print jobs are collected here and
//! handed to JS whole.

use std::collections::{HashMap, VecDeque};

use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::backend::RdpdrBackend;
use ironrdp::rdpdr::pdu::efs::*;
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp_core::impl_as_any;
use ironrdp_svc::SvcMessage;
use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};

/// Print jobs above this are dropped instead of growing memory without end.
const MAX_PRINT_JOB: usize = 256 * 1024 * 1024;

#[derive(Debug)]
pub struct DriveHost {
    host: Object,
}

impl DriveHost {
    pub fn new(host: Object) -> Self {
        Self { host }
    }

    fn call(&self, name: &str, args: &[JsValue]) -> JsValue {
        let Some(f) = Reflect::get(&self.host, &name.into())
            .ok()
            .and_then(|f| f.dyn_into::<Function>().ok())
        else {
            return JsValue::UNDEFINED;
        };
        let list = Array::new();
        for arg in args {
            list.push(arg);
        }
        f.apply(&JsValue::NULL, &list).unwrap_or(JsValue::UNDEFINED)
    }
}

// JsValue is not Send, but WASM here is single threaded.
unsafe impl Send for DriveHost {}

/// File details as JS reports them, with times in ms since the epoch.
#[derive(Debug)]
struct Info {
    name: String,
    size: i64,
    dir: bool,
    readonly: bool,
    ctime: f64,
    atime: f64,
    mtime: f64,
}

fn num(o: &JsValue, key: &str) -> f64 {
    Reflect::get(o, &key.into()).ok().and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn flag(o: &JsValue, key: &str) -> bool {
    Reflect::get(o, &key.into()).ok().and_then(|v| v.as_bool()).unwrap_or(false)
}

fn info_from(o: &JsValue) -> Option<Info> {
    if !o.is_object() {
        return None;
    }
    Some(Info {
        name: Reflect::get(o, &"name".into())
            .ok()
            .and_then(|v| v.as_string())
            .unwrap_or_default(),
        size: num(o, "size") as i64,
        dir: flag(o, "dir"),
        readonly: flag(o, "readonly"),
        ctime: num(o, "ctime"),
        atime: num(o, "atime"),
        mtime: num(o, "mtime"),
    })
}

/// An NTSTATUS JS returned as a number; anything else is a failure.
fn status_from(value: &JsValue) -> NtStatus {
    NtStatus::from(value.as_f64().map(|n| n as u32).unwrap_or(0xC000_0001))
}

fn result_status(result: &JsValue) -> JsValue {
    Reflect::get(result, &"status".into()).unwrap_or(JsValue::UNDEFINED)
}

/// ms since the Unix epoch to a Windows FILETIME.
fn filetime(ms: f64) -> i64 {
    (ms as i64).saturating_mul(10_000).saturating_add(116_444_736_000_000_000)
}

fn attributes(info: &Info) -> FileAttributes {
    let mut attrs = if info.dir {
        FileAttributes::FILE_ATTRIBUTE_DIRECTORY
    } else {
        FileAttributes::FILE_ATTRIBUTE_ARCHIVE
    };
    if info.name.len() > 1 && info.name.starts_with('.') && !info.name.starts_with("..") {
        attrs |= FileAttributes::FILE_ATTRIBUTE_HIDDEN;
    }
    if info.readonly {
        attrs |= FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    attrs
}

#[derive(Debug, Default)]
struct PrintJob {
    data: Vec<u8>,
    dropped: bool,
}

#[derive(Debug)]
pub struct DriveBackend {
    host: DriveHost,
    listings: HashMap<u32, VecDeque<Info>>,
    jobs: HashMap<u32, PrintJob>,
    next_job: u32,
}

impl DriveBackend {
    pub fn new(host: DriveHost) -> Self {
        Self {
            host,
            listings: HashMap::new(),
            jobs: HashMap::new(),
            next_job: 1,
        }
    }
}

impl_as_any!(DriveBackend);

fn msg(pdu: RdpdrPdu) -> PduResult<Vec<SvcMessage>> {
    Ok(vec![SvcMessage::from(pdu)])
}

impl RdpdrBackend for DriveBackend {
    fn reset(&mut self) -> PduResult<()> {
        self.listings.clear();
        self.jobs.clear();
        self.host.call("fs_reset", &[]);
        Ok(())
    }

    fn handle_server_device_announce_response(&mut self, _pdu: ServerDeviceAnnounceResponse) -> PduResult<()> {
        Ok(())
    }

    fn handle_scard_call(
        &mut self,
        _req: DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<Vec<SvcMessage>> {
        Ok(Vec::new())
    }

    fn handle_printer_io_request(&mut self, req: PrinterIoRequest) -> PduResult<Vec<SvcMessage>> {
        match req {
            PrinterIoRequest::Create(create) => {
                let id = self.next_job;
                self.next_job = self.next_job.wrapping_add(1).max(1);
                self.jobs.insert(id, PrintJob::default());
                msg(RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
                    device_io_reply: DeviceIoResponse::new(create.device_io_request, NtStatus::SUCCESS),
                    file_id: id,
                    information: Information::FILE_OPENED,
                }))
            }
            PrinterIoRequest::Write(write) => {
                let len = write.write_data.len();
                let status = match self.jobs.get_mut(&write.device_io_request.file_id) {
                    Some(job) => {
                        if job.data.len() + len > MAX_PRINT_JOB {
                            job.dropped = true;
                            job.data = Vec::new();
                        } else if !job.dropped {
                            job.data.extend_from_slice(&write.write_data);
                        }
                        NtStatus::SUCCESS
                    }
                    None => NtStatus::INVALID_HANDLE,
                };
                msg(RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
                    device_io_reply: DeviceIoResponse::new(write.device_io_request, status),
                    length: if status == NtStatus::SUCCESS {
                        u32::try_from(len).unwrap_or(0)
                    } else {
                        0
                    },
                }))
            }
            PrinterIoRequest::Close(close) => {
                let status = match self.jobs.remove(&close.device_io_request.file_id) {
                    Some(job) => {
                        if !job.dropped && !job.data.is_empty() {
                            self.host.call("print", &[Uint8Array::from(job.data.as_slice()).into()]);
                        }
                        NtStatus::SUCCESS
                    }
                    None => NtStatus::INVALID_HANDLE,
                };
                msg(RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
                    device_io_response: DeviceIoResponse::new(close.device_io_request, status),
                }))
            }
        }
    }

    fn reject_printer_write(&mut self, req: DeviceIoRequest) -> PduResult<Vec<SvcMessage>> {
        if let Some(job) = self.jobs.get_mut(&req.file_id) {
            job.dropped = true;
            job.data = Vec::new();
        }
        msg(RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
            device_io_reply: DeviceIoResponse::new(req, NtStatus::NOT_SUPPORTED),
            length: 0,
        }))
    }

    fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
        match req {
            ServerDriveIoRequest::ServerCreateDriveRequest(r) => self.create(r),
            ServerDriveIoRequest::DeviceReadRequest(r) => self.read(r),
            ServerDriveIoRequest::DeviceWriteRequest(r) => self.write(r),
            ServerDriveIoRequest::DeviceCloseRequest(r) => {
                let id = r.device_io_request.file_id;
                self.listings.remove(&id);
                self.host.call("fs_close", &[id.into()]);
                msg(RdpdrPdu::DeviceCloseResponse(DeviceCloseResponse {
                    device_io_response: DeviceIoResponse::new(r.device_io_request, NtStatus::SUCCESS),
                }))
            }
            ServerDriveIoRequest::DeviceFlushBuffersRequest(r) => {
                msg(RdpdrPdu::DeviceFlushBuffersResponse(DeviceFlushBuffersResponse {
                    device_io_response: DeviceIoResponse::new(r.device_io_request, NtStatus::SUCCESS),
                }))
            }
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(r) => self.query_directory(r),
            ServerDriveIoRequest::ServerDriveQueryInformationRequest(r) => self.query_information(r),
            ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(r) => self.query_volume(r),
            ServerDriveIoRequest::ServerDriveSetInformationRequest(r) => self.set_information(r),
            ServerDriveIoRequest::DeviceControlRequest(r) => {
                msg(RdpdrPdu::DeviceControlResponse(DeviceControlResponse {
                    device_io_reply: DeviceIoResponse::new(r.header, NtStatus::SUCCESS),
                    output_buffer: None,
                }))
            }
            ServerDriveIoRequest::ServerDriveQuerySecurityRequest(r) => {
                msg(RdpdrPdu::ClientDriveQuerySecurityResponse(ClientDriveQuerySecurityResponse {
                    device_io_response: DeviceIoResponse::new(r.device_io_request, NtStatus::NOT_SUPPORTED),
                    security_descriptor: None,
                }))
            }
            ServerDriveIoRequest::ServerDriveSetSecurityRequest(r) => {
                let response = ClientDriveSetSecurityResponse::new(&r, NtStatus::NOT_SUPPORTED)
                    .map_err(|e| ironrdp::pdu::encode_err!(e))?;
                msg(RdpdrPdu::ClientDriveSetSecurityResponse(response))
            }
            // Change notifications stay pending, like the nix backend; locks too.
            ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_) => Ok(Vec::new()),
            ServerDriveIoRequest::ServerDriveLockControlRequest(_) => Ok(Vec::new()),
        }
    }
}

impl DriveBackend {
    fn create(&mut self, r: DeviceCreateRequest) -> PduResult<Vec<SvcMessage>> {
        let result = self.host.call(
            "fs_create",
            &[
                r.path.clone().into(),
                u32::from(r.create_disposition).into(),
                r.create_options.bits().into(),
                r.desired_access.bits().into(),
            ],
        );
        let status = status_from(&result_status(&result));
        let opened = status == NtStatus::SUCCESS;
        let information = if !opened {
            Information::empty()
        } else {
            match num(&result, "information") as u32 {
                0 => Information::FILE_SUPERSEDED,
                1 => Information::FILE_OPENED,
                3 => Information::FILE_OVERWRITTEN,
                _ => Information::FILE_SUPERSEDED,
            }
        };
        msg(RdpdrPdu::DeviceCreateResponse(DeviceCreateResponse {
            device_io_reply: DeviceIoResponse::new(r.device_io_request, status),
            file_id: if opened { num(&result, "handle") as u32 } else { 0 },
            information,
        }))
    }

    fn read(&mut self, r: DeviceReadRequest) -> PduResult<Vec<SvcMessage>> {
        let id = r.device_io_request.file_id;
        let result = self.host.call("fs_read", &[id.into(), (r.offset as f64).into(), r.length.into()]);
        let (status, data) = if result.is_instance_of::<Uint8Array>() {
            (NtStatus::SUCCESS, Uint8Array::new(&result).to_vec())
        } else {
            (status_from(&result), Vec::new())
        };
        msg(RdpdrPdu::DeviceReadResponse(DeviceReadResponse {
            device_io_reply: DeviceIoResponse::new(r.device_io_request, status),
            read_data: data,
        }))
    }

    fn write(&mut self, r: DeviceWriteRequest) -> PduResult<Vec<SvcMessage>> {
        let id = r.device_io_request.file_id;
        let data = Uint8Array::from(r.write_data.as_slice());
        let written = self
            .host
            .call("fs_write", &[id.into(), (r.offset as f64).into(), data.into()])
            .as_f64()
            .unwrap_or(-1.0);
        let ok = written >= 0.0 && written as usize == r.write_data.len();
        msg(RdpdrPdu::DeviceWriteResponse(DeviceWriteResponse {
            device_io_reply: DeviceIoResponse::new(
                r.device_io_request,
                if ok { NtStatus::SUCCESS } else { NtStatus::UNSUCCESSFUL },
            ),
            length: if ok { u32::try_from(r.write_data.len()).unwrap_or(0) } else { 0 },
        }))
    }

    fn query_information(&mut self, r: ServerDriveQueryInformationRequest) -> PduResult<Vec<SvcMessage>> {
        let id = r.device_io_request.file_id;
        let reply = |status, buffer| {
            msg(RdpdrPdu::ClientDriveQueryInformationResponse(ClientDriveQueryInformationResponse {
                device_io_response: DeviceIoResponse::new(r.device_io_request.clone(), status),
                buffer,
            }))
        };
        let Some(info) = info_from(&self.host.call("fs_info", &[id.into()])) else {
            return reply(NtStatus::NO_SUCH_FILE, None);
        };
        let attrs = attributes(&info);
        let level = r.file_info_class_lvl;
        let buffer = if level == FileInformationClassLevel::FILE_BASIC_INFORMATION {
            FileInformationClass::Basic(FileBasicInformation {
                creation_time: filetime(info.ctime),
                last_access_time: filetime(info.atime),
                last_write_time: filetime(info.mtime),
                change_time: filetime(info.ctime),
                file_attributes: attrs,
            })
        } else if level == FileInformationClassLevel::FILE_STANDARD_INFORMATION {
            FileInformationClass::Standard(FileStandardInformation {
                allocation_size: info.size,
                end_of_file: info.size,
                number_of_links: 1,
                delete_pending: Boolean::False,
                directory: if info.dir { Boolean::True } else { Boolean::False },
            })
        } else if level == FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION {
            FileInformationClass::AttributeTag(FileAttributeTagInformation {
                file_attributes: attrs,
                reparse_tag: 0,
            })
        } else {
            return reply(NtStatus::NOT_SUPPORTED, None);
        };
        reply(NtStatus::SUCCESS, Some(buffer))
    }

    fn query_volume(&mut self, r: ServerDriveQueryVolumeInformationRequest) -> PduResult<Vec<SvcMessage>> {
        let volume = self.host.call("fs_volume", &[]);
        // Report 4 KiB allocation units of one byte sectors, like the nix backend's statvfs.
        let total = (num(&volume, "total") / 4096.0) as i64;
        let free = (num(&volume, "free") / 4096.0) as i64;
        let level = r.fs_info_class_lvl;
        let buffer = if level == FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION {
            Some(FileSystemInformationClass::FileFsFullSizeInformation(FileFsFullSizeInformation {
                total_alloc_units: total,
                caller_available_alloc_units: free,
                actual_available_alloc_units: free,
                sectors_per_alloc_unit: 4096,
                bytes_per_sector: 1,
            }))
        } else if level == FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION {
            Some(FileSystemInformationClass::FileFsSizeInformation(FileFsSizeInformation {
                total_alloc_units: total,
                available_alloc_units: free,
                sectors_per_alloc_unit: 4096,
                bytes_per_sector: 1,
            }))
        } else if level == FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION {
            Some(FileSystemInformationClass::FileFsAttributeInformation(FileFsAttributeInformation {
                file_system_attributes: FileSystemAttributes::FILE_CASE_SENSITIVE_SEARCH
                    | FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                    | FileSystemAttributes::FILE_UNICODE_ON_DISK,
                max_component_name_len: 260,
                file_system_name: "FAT32".to_owned(),
            }))
        } else if level == FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION {
            Some(FileSystemInformationClass::FileFsVolumeInformation(FileFsVolumeInformation {
                volume_creation_time: filetime(0.0),
                volume_serial_number: 0x5445_524d,
                supports_objects: Boolean::False,
                volume_label: "TERMIX".to_owned(),
            }))
        } else if level == FileSystemInformationClassLevel::FILE_FS_DEVICE_INFORMATION {
            Some(FileSystemInformationClass::FileFsDeviceInformation(FileFsDeviceInformation {
                // FILE_DEVICE_DISK
                device_type: 0x0000_0007,
                characteristics: Characteristics::empty(),
            }))
        } else {
            None
        };
        let status = if buffer.is_some() { NtStatus::SUCCESS } else { NtStatus::NOT_SUPPORTED };
        msg(RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
            ClientDriveQueryVolumeInformationResponse {
                device_io_reply: DeviceIoResponse::new(r.device_io_request, status),
                buffer,
            },
        ))
    }

    fn set_information(&mut self, r: ServerDriveSetInformationRequest) -> PduResult<Vec<SvcMessage>> {
        let id = r.device_io_request.file_id;
        let status = match &r.set_buffer {
            FileInformationClass::Rename(info) => self.host.call(
                "fs_set",
                &[
                    id.into(),
                    "rename".into(),
                    info.file_name.clone().into(),
                    matches!(info.replace_if_exists, Boolean::True).into(),
                ],
            ),
            FileInformationClass::Disposition(info) => self.host.call(
                "fs_set",
                &[id.into(), "delete".into(), (info.delete_pending != 0).into()],
            ),
            FileInformationClass::EndOfFile(info) => self.host.call(
                "fs_set",
                &[id.into(), "truncate".into(), (info.end_of_file as f64).into()],
            ),
            FileInformationClass::Allocation(_) | FileInformationClass::Basic(_) => {
                JsValue::from_f64(0.0)
            }
            _ => JsValue::from_f64(f64::from(0xC000_00BB_u32)),
        };
        let status = status_from(&status);
        let response =
            ClientDriveSetInformationResponse::new(&r, status).map_err(|e| ironrdp::pdu::encode_err!(e))?;
        msg(RdpdrPdu::ClientDriveSetInformationResponse(response))
    }

    fn query_directory(&mut self, r: ServerDriveQueryDirectoryRequest) -> PduResult<Vec<SvcMessage>> {
        let id = r.device_io_request.file_id;
        let initial = r.initial_query > 0;
        if initial {
            let list = self.host.call("fs_list", &[id.into(), r.path.clone().into()]);
            if !Array::is_array(&list) {
                self.listings.remove(&id);
                return msg(RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
                    device_io_reply: DeviceIoResponse::new(r.device_io_request, NtStatus::NO_SUCH_FILE),
                    buffer: None,
                }));
            }
            self.listings.insert(id, Array::from(&list).iter().filter_map(|v| info_from(&v)).collect());
        }
        let next = self.listings.get_mut(&id).and_then(|q| q.pop_front());
        let Some(info) = next else {
            let status = if initial { NtStatus::NO_SUCH_FILE } else { NtStatus::NO_MORE_FILES };
            return msg(RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
                device_io_reply: DeviceIoResponse::new(r.device_io_request, status),
                buffer: None,
            }));
        };
        let attrs = attributes(&info);
        let (c, a, w) = (filetime(info.ctime), filetime(info.atime), filetime(info.mtime));
        let level = r.file_info_class_lvl;
        let buffer = if level == FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION {
            Some(FileInformationClass::BothDirectory(FileBothDirectoryInformation::new(
                c, a, w, c, info.size, attrs, info.name,
            )))
        } else if level == FileInformationClassLevel::FILE_FULL_DIRECTORY_INFORMATION {
            Some(FileInformationClass::FullDirectory(FileFullDirectoryInformation::new(
                c, a, w, c, info.size, attrs, info.name,
            )))
        } else if level == FileInformationClassLevel::FILE_DIRECTORY_INFORMATION {
            Some(FileInformationClass::Directory(FileDirectoryInformation::new(
                c, a, w, c, info.size, attrs, info.name,
            )))
        } else if level == FileInformationClassLevel::FILE_NAMES_INFORMATION {
            Some(FileInformationClass::Names(FileNamesInformation::new(info.name)))
        } else {
            None
        };
        let status = if buffer.is_some() { NtStatus::SUCCESS } else { NtStatus::NOT_SUPPORTED };
        msg(RdpdrPdu::ClientDriveQueryDirectoryResponse(ClientDriveQueryDirectoryResponse {
            device_io_reply: DeviceIoResponse::new(r.device_io_request, status),
            buffer,
        }))
    }
}
