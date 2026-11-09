//! RDSTLS (MS-RDPBCGR 2.2.17): after TLS, the client proves itself with the
//! password cookie a Server Redirection PDU handed it. GNOME Remote Login
//! takes it for the user's session, whose one-time account name NLA cannot
//! always carry. IronRDP negotiates the protocol but does not run it.

const VERSION_1: u16 = 0x01;
const TYPE_CAPABILITIES: u16 = 0x01;
const TYPE_AUTHREQ: u16 = 0x02;
const TYPE_AUTHRSP: u16 = 0x04;
const DATA_CAPABILITIES: u16 = 0x01;
const DATA_PASSWORD_CREDS: u16 = 0x01;
const DATA_RESULT_CODE: u16 = 0x01;

/// The server's Capabilities PDU size.
pub const CAPABILITIES_LEN: usize = 8;
/// The server's Authentication Response PDU size.
pub const RESPONSE_LEN: usize = 10;

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

/// Checks the server's Capabilities PDU offers version 1.
pub fn read_capabilities(pdu: &[u8]) -> Result<(), String> {
    let ok = pdu.len() == CAPABILITIES_LEN
        && u16_at(pdu, 2) == TYPE_CAPABILITIES
        && u16_at(pdu, 4) == DATA_CAPABILITIES
        && u16_at(pdu, 6) & VERSION_1 != 0;
    ok.then_some(()).ok_or_else(|| "RDSTLS capabilities not understood".to_owned())
}

/// The Authentication Request with the redirect's GUID, account and cookie.
pub fn auth_request(guid: &[u8], username: &str, domain: &str, cookie: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in [VERSION_1, TYPE_AUTHREQ, DATA_PASSWORD_CREDS] {
        out.extend(value.to_le_bytes());
    }
    let wide = |s: &str| s.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
    for data in [guid, &wide(username), &wide(domain), cookie] {
        out.extend((data.len() as u16).to_le_bytes());
        out.extend(data);
    }
    out
}

/// The server's verdict on the request: Ok, or the result code it sent.
pub fn read_response(pdu: &[u8]) -> Result<(), String> {
    if pdu.len() != RESPONSE_LEN || u16_at(pdu, 2) != TYPE_AUTHRSP || u16_at(pdu, 4) != DATA_RESULT_CODE {
        return Err("RDSTLS response not understood".to_owned());
    }
    match u32::from_le_bytes([pdu[6], pdu[7], pdu[8], pdu[9]]) {
        0 => Ok(()),
        code => Err(format!("RDSTLS authentication refused (0x{code:08x})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_capabilities_and_responses() {
        assert!(read_capabilities(&[1, 0, 1, 0, 1, 0, 3, 0]).is_ok());
        assert!(read_capabilities(&[1, 0, 4, 0, 1, 0, 1, 0]).is_err());
        assert!(read_response(&[1, 0, 4, 0, 1, 0, 0, 0, 0, 0]).is_ok());
        assert_eq!(
            read_response(&[1, 0, 4, 0, 1, 0, 0x2e, 5, 0, 0]),
            Err("RDSTLS authentication refused (0x0000052e)".to_owned())
        );
    }

    #[test]
    fn writes_the_account_name_whole() {
        let pdu = auth_request(&[7, 7], "a\\b", "", &[1, 2]);
        let mut expected = vec![1, 0, 2, 0, 1, 0, 2, 0, 7, 7, 8, 0];
        expected.extend([b'a', 0, b'\\', 0, b'b', 0, 0, 0]);
        expected.extend([2, 0, 0, 0, 2, 0, 1, 2]);
        assert_eq!(pdu, expected);
    }
}
