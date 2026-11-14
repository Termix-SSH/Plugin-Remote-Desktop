//! Server Redirection PDU (MS-RDPBCGR 2.2.13.1). GNOME Remote Login sends it
//! to move the client to the user's own session. IronRDP does not read it,
//! so the frame is picked apart here before the connector sees it.

const SHARE_CONTROL_REDIRECT: u16 = 0xa;

const LB_TARGET_NET_ADDRESS: u32 = 0x1;
const LB_LOAD_BALANCE_INFO: u32 = 0x2;
const LB_USERNAME: u32 = 0x4;
const LB_DOMAIN: u32 = 0x8;
const LB_PASSWORD: u32 = 0x10;
const LB_TARGET_FQDN: u32 = 0x100;
const LB_TARGET_NETBIOS: u32 = 0x200;
const LB_TARGET_NET_ADDRESSES: u32 = 0x800;
const LB_CLIENT_TSV_URL: u32 = 0x1000;
const LB_PASSWORD_IS_PK_ENCRYPTED: u32 = 0x4000;
const LB_REDIRECTION_GUID: u32 = 0x8000;
const LB_TARGET_CERTIFICATE: u32 = 0x10000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Redirect {
    pub address: String,
    pub fqdn: String,
    pub load_balance_info: Vec<u8>,
    pub username: String,
    pub domain: String,
    pub password: String,
    /// For RDSTLS: the redirection GUID and the password cookie, as sent.
    pub redirection_guid: Vec<u8>,
    pub password_cookie: Vec<u8>,
}

/// Reads the redirect out of a whole TPKT frame, or None when the frame is
/// something else.
pub fn parse_frame(frame: &[u8]) -> Option<Redirect> {
    // TPKT (4) + X.224 data (3), then an MCS send data indication.
    if frame.len() < 14 || frame[0] != 3 || frame[7] >> 2 != 26 {
        return None;
    }
    // Initiator (2), channel (2), flags (1), then the PER length.
    let mut at = 13;
    let first = *frame.get(at)?;
    at += if first & 0x80 != 0 { 2 } else { 1 };
    parse_share_control(frame.get(at..)?)
}

fn parse_share_control(data: &[u8]) -> Option<Redirect> {
    // totalLength, pduType, pduSource, then two pad bytes.
    if data.len() < 8 {
        return None;
    }
    let kind = u16::from_le_bytes([data[2], data[3]]) & 0xf;
    if kind != SHARE_CONTROL_REDIRECT {
        return None;
    }
    parse_packet(&data[8..])
}

/// RDP_SERVER_REDIRECTION_PACKET: flags, length, session id, redirect flags,
/// then each flagged field as a length and its bytes.
fn parse_packet(data: &[u8]) -> Option<Redirect> {
    let mut r = Reader { data, at: 0 };
    r.u16()?;
    r.u16()?;
    r.u32()?;
    let flags = r.u32()?;
    let mut out = Redirect::default();
    if flags & LB_TARGET_NET_ADDRESS != 0 {
        out.address = utf16(r.field()?);
    }
    if flags & LB_LOAD_BALANCE_INFO != 0 {
        out.load_balance_info = r.field()?.to_vec();
    }
    if flags & LB_USERNAME != 0 {
        out.username = utf16(r.field()?);
    }
    if flags & LB_DOMAIN != 0 {
        out.domain = utf16(r.field()?);
    }
    if flags & LB_PASSWORD != 0 {
        let raw = r.field()?;
        // A password cookie is opaque: it goes back as is over RDSTLS.
        if flags & LB_PASSWORD_IS_PK_ENCRYPTED == 0 {
            out.password = utf16(raw);
        } else {
            out.password_cookie = raw.to_vec();
        }
    }
    if flags & LB_TARGET_FQDN != 0 {
        out.fqdn = utf16(r.field()?);
    }
    if flags & LB_TARGET_NETBIOS != 0 {
        r.field()?;
    }
    if flags & LB_CLIENT_TSV_URL != 0 {
        r.field()?;
    }
    if flags & LB_REDIRECTION_GUID != 0 {
        out.redirection_guid = r.field()?.to_vec();
    }
    if flags & LB_TARGET_CERTIFICATE != 0 {
        r.field()?;
    }
    if flags & LB_TARGET_NET_ADDRESSES != 0 {
        // Count, then a length and an address each; the first one is enough.
        let list = r.field()?;
        if out.address.is_empty() && list.len() >= 8 {
            let len = u32::from_le_bytes([list[4], list[5], list[6], list[7]]) as usize;
            if let Some(first) = list.get(8..8 + len) {
                out.address = utf16(first);
            }
        }
    }
    Some(out)
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let out = self.data.get(self.at..end)?;
        self.at = end;
        Some(out)
    }

    fn u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn field(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        // A target certificate can outgrow 4 KB; the PDU is at most 64 KB.
        if len > 0xffff {
            return None;
        }
        self.take(len)
    }
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units).trim_end_matches('\0').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(s: &str) -> Vec<u8> {
        let mut v: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        v.extend([0, 0]);
        v
    }

    fn field(out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend((bytes.len() as u32).to_le_bytes());
        out.extend(bytes);
    }

    fn frame(flags: u32, body: &[u8]) -> Vec<u8> {
        let mut packet = vec![0x00, 0x04, 0, 0, 0, 0, 0, 0];
        packet.extend(flags.to_le_bytes());
        packet.extend(body);
        let mut share = vec![0, 0, 0x1a, 0x00, 0xea, 0x03, 0, 0];
        share.extend(&packet);
        let mut mcs = vec![0x68, 0x00, 0x01, 0x03, 0xeb, 0x70];
        if share.len() < 0x80 {
            mcs.push(share.len() as u8);
        } else {
            mcs.extend([0x80 | (share.len() >> 8) as u8, share.len() as u8]);
        }
        mcs.extend(&share);
        let mut out = vec![3, 0, 0, 0, 0x02, 0xf0, 0x80];
        out.extend(&mcs);
        let len = out.len() as u16;
        out[2..4].copy_from_slice(&len.to_be_bytes());
        out
    }

    #[test]
    fn reads_address_token_and_user() {
        let mut body = Vec::new();
        field(&mut body, &wide("10.0.0.5"));
        field(&mut body, b"Cookie: msts=abc\r\n");
        field(&mut body, &wide("bob"));
        let f = frame(LB_TARGET_NET_ADDRESS | LB_LOAD_BALANCE_INFO | LB_USERNAME, &body);
        let r = parse_frame(&f).expect("redirect");
        assert_eq!(r.address, "10.0.0.5");
        assert_eq!(r.load_balance_info, b"Cookie: msts=abc\r\n");
        assert_eq!(r.username, "bob");
    }

    #[test]
    fn keeps_an_encrypted_password_as_a_cookie() {
        let mut body = Vec::new();
        field(&mut body, &[1, 2, 3, 4]);
        let f = frame(LB_PASSWORD | LB_PASSWORD_IS_PK_ENCRYPTED, &body);
        let r = parse_frame(&f).expect("redirect");
        assert_eq!(r.password, "");
        assert_eq!(r.password_cookie, [1, 2, 3, 4]);
    }

    #[test]
    fn reads_the_guid_past_the_certificate_and_addresses_last() {
        let mut body = Vec::new();
        field(&mut body, &wide("10.0.0.5"));
        field(&mut body, &wide("guid"));
        field(&mut body, &[9; 5000]);
        let mut list = 1u32.to_le_bytes().to_vec();
        let other = wide("10.0.0.6");
        list.extend((other.len() as u32).to_le_bytes());
        list.extend(&other);
        field(&mut body, &list);
        let flags = LB_TARGET_NET_ADDRESS | LB_REDIRECTION_GUID | LB_TARGET_CERTIFICATE | LB_TARGET_NET_ADDRESSES;
        let r = parse_frame(&frame(flags, &body)).expect("redirect");
        assert_eq!(r.address, "10.0.0.5");
        assert_eq!(r.redirection_guid, wide("guid"));
    }

    #[test]
    fn ignores_other_frames_and_cut_fields() {
        assert!(parse_frame(&[3, 0, 0, 7, 2, 0xf0, 0x80]).is_none());
        let f = frame(LB_USERNAME, &[0xff, 0xff, 0, 0]);
        assert!(parse_frame(&f).is_none());
    }
}
