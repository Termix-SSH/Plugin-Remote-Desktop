/**
 * Keyboard layouts for RDP's server-layout setting, the same names guacd
 * accepts. Each layer lists what the keys in KEYS type, in that order; a
 * space means the key types nothing there (or a dead key). Characters a
 * layout can't type go to the server as Unicode events.
 */

/** Scancodes of the printable keys: number row, then the three letter rows. */
export const KEYS = [
  0x29, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1e,
  0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2b, 0x56, 0x2c,
  0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35,
];

export interface LayoutSpec {
  /** Windows keyboard layout id sent in the client info. */
  id: number;
  base: string;
  shift: string;
  altgr?: string;
  altgrShift?: string;
  /** Keys outside KEYS, as [scancode, base, shift]. */
  extra?: Array<[number, string, string]>;
  /** Send every printable character as Unicode. */
  unicode?: boolean;
}

const US_BASE =
  "`1234567890-=" + "qwertyuiop[]" + "asdfghjkl;'\\" + "\\zxcvbnm,./";
const US_SHIFT =
  "~!@#$%^&*()_+" + "QWERTYUIOP{}" + 'ASDFGHJKL:"|' + "|ZXCVBNM<>?";

export const LAYOUTS: Record<string, LayoutSpec> = {
  "en-us-qwerty": { id: 0x409, base: US_BASE, shift: US_SHIFT },
  failsafe: { id: 0x409, base: US_BASE, shift: US_SHIFT, unicode: true },
  "en-gb-qwerty": {
    id: 0x809,
    base: "`1234567890-=" + "qwertyuiop[]" + "asdfghjkl;'#" + "\\zxcvbnm,./",
    shift: '¬!"£$%^&*()_+' + "QWERTYUIOP{}" + "ASDFGHJKL:@~" + "|ZXCVBNM<>?",
    altgr: "¦   €        " + "            " + "            " + "           ",
  },
  "de-de-qwertz": {
    id: 0x407,
    base: " 1234567890ß " + "qwertzuiopü+" + "asdfghjklöä#" + "<yxcvbnm,.-",
    shift: '°!"§$%&/()=? ' + "QWERTZUIOPÜ*" + "ASDFGHJKLÖÄ'" + ">YXCVBNM;:_",
    altgr: "  ²³   {[]}\\ " + "@ €        ~" + "            " + "|      µ   ",
  },
  "de-ch-qwertz": {
    id: 0x807,
    base: "§1234567890' " + "qwertzuiopü " + "asdfghjklöä$" + "<yxcvbnm,.-",
    shift: '°+"*ç%&/()=? ' + "QWERTZUIOPè!" + "ASDFGHJKLéà£" + ">YXCVBNM;:_",
    altgr: " ¦@#°§¬|¢    " + "  €       []" + "          {}" + "\\          ",
  },
  "fr-fr-azerty": {
    id: 0x40c,
    base: "²&é\"'(-è_çà)=" + "azertyuiop $" + "qsdfghjklmù*" + "<wxcvbn,;:!",
    shift: " 1234567890°+" + "AZERTYUIOP £" + "QSDFGHJKLM%µ" + ">WXCVBN?./§",
    altgr: "   #{[| \\ @]}" + "  €        ¤" + "            " + "           ",
  },
  "fr-be-azerty": {
    id: 0x80c,
    base: "²&é\"'(§è!çà)-" + "azertyuiop $" + "qsdfghjklmùµ" + "<wxcvbn,;:=",
    shift: "³1234567890°_" + "AZERTYUIOP *" + "QSDFGHJKLM%£" + ">WXCVBN?./+",
    altgr: " |@#  ^  {}  " + "  €       []" + "            " + "\\          ",
  },
  "fr-ch-qwertz": {
    id: 0x100c,
    base: "§1234567890' " + "qwertzuiopè " + "asdfghjkléà$" + "<yxcvbnm,.-",
    shift: '°+"*ç%&/()=? ' + "QWERTZUIOPü!" + "ASDFGHJKLöä£" + ">YXCVBNM;:_",
    altgr: " ¦@#°§¬|¢    " + "  €       []" + "          {}" + "\\          ",
  },
  "it-it-qwerty": {
    id: 0x410,
    base: "\\1234567890'ì" + "qwertyuiopè+" + "asdfghjklòàù" + "<zxcvbnm,.-",
    shift: '|!"£$%&/()=?^' + "QWERTYUIOPé*" + "ASDFGHJKLç°§" + ">ZXCVBNM;:_",
    altgr: "             " + "  €       []" + "         @# " + "           ",
  },
  "es-es-qwerty": {
    id: 0x40a,
    base: "º1234567890'¡" + "qwertyuiop +" + "asdfghjklñ ç" + "<zxcvbnm,.-",
    shift: 'ª!"·$%&/()=?¿' + "QWERTYUIOP *" + "ASDFGHJKLÑ Ç" + ">ZXCVBNM;:_",
    altgr: "\\|@#~€¬      " + "  €       []" + "          {}" + "           ",
  },
  "es-latam-qwerty": {
    id: 0x80a,
    base: "|1234567890'¿" + "qwertyuiop +" + "asdfghjklñ{}" + "<zxcvbnm,.-",
    shift: '°!"#$%&/()=?¡' + "QWERTYUIOP *" + "ASDFGHJKLÑ[]" + ">ZXCVBNM;:_",
    altgr: "¬          \\ " + "@           " + "            " + "           ",
  },
  "pt-pt-qwerty": {
    id: 0x816,
    base: "\\1234567890'«" + "qwertyuiop+ " + "asdfghjklçº " + "<zxcvbnm,.-",
    shift: '|!"#$%&/()=?»' + "QWERTYUIOP* " + "ASDFGHJKLÇª " + ">ZXCVBNM;:_",
    altgr: "  @£§€ {[]}  " + "  €         " + "            " + "           ",
  },
  "pt-br-qwerty": {
    id: 0x416,
    base: "'1234567890-=" + "qwertyuiop [" + "asdfghjklç ]" + "\\zxcvbnm,.;",
    shift: '"!@#$% &*()_+' + "QWERTYUIOP {" + "ASDFGHJKLÇ }" + "|ZXCVBNM<>:",
    altgr: " ¹²³£¢¬     §" + "/?°        ª" + "           º" + "           ",
    extra: [[0x73, "/", "?"]],
  },
  "sv-se-qwerty": {
    id: 0x41d,
    base: "§1234567890+ " + "qwertyuiopå " + "asdfghjklöä'" + "<zxcvbnm,.-",
    shift: '½!"#¤%&/()=? ' + "QWERTYUIOPÅ " + "ASDFGHJKLÖÄ*" + ">ZXCVBNM;:_",
    altgr: "  @£$€ {[]}\\ " + "  €         " + "            " + "|      µ   ",
  },
  "da-dk-qwerty": {
    id: 0x406,
    base: "½1234567890+ " + "qwertyuiopå " + "asdfghjklæø'" + "<zxcvbnm,.-",
    shift: '§!"#¤%&/()=? ' + "QWERTYUIOPÅ " + "ASDFGHJKLÆØ*" + ">ZXCVBNM;:_",
    altgr: "  @£$€ {[]} |" + "  €         " + "            " + "\\      µ   ",
  },
  "no-no-qwerty": {
    id: 0x414,
    base: "|1234567890+\\" + "qwertyuiopå " + "asdfghjkløæ'" + "<zxcvbnm,.-",
    shift: '§!"#¤%&/()=? ' + "QWERTYUIOPÅ " + "ASDFGHJKLØÆ*" + ">ZXCVBNM;:_",
    altgr: "  @£$€ {[]}  " + "  €         " + "            " + "       µ   ",
  },
  "pl-pl-qwerty": {
    id: 0x415,
    base: US_BASE,
    shift: US_SHIFT,
    altgr: "             " + "  ę     ó   " + "ąś      ł   " + " żźć  ń    ",
    altgrShift:
      "             " + "  Ę     Ó   " + "ĄŚ      Ł   " + " ŻŹĆ  Ń    ",
  },
  "hu-hu-qwertz": {
    id: 0x40e,
    base: "0123456789öüó" + "qwertzuiopőú" + "asdfghjkléáű" + "íyxcvbnm,.-",
    shift: "§'\"+!%/=()ÖÜÓ" + "QWERTZUIOPŐÚ" + "ASDFGHJKLÉÁŰ" + "ÍYXCVBNM?:_",
    altgr: " ~           " + "\\|Ä   €Í  ÷×" + "äđĐ[] íłŁ$ß¤" + "<>#&@{}<;>*",
  },
  "ro-ro-qwerty": {
    id: 0x418,
    base: "„1234567890-=" + "qwertyuiopăî" + "asdfghjklșțâ" + "\\zxcvbnm,./",
    shift: "”!@#$%^&*()_+" + "QWERTYUIOPĂÎ" + "ASDFGHJKLȘȚÂ" + "|ZXCVBNM;:?",
    altgr: "`            " + "          []" + "         ;'\\" + "           ",
  },
  "tr-tr-qwerty": {
    id: 0x41f,
    base: '"1234567890*-' + "qwertyuıopğü" + "asdfghjklşi," + "<zxcvbnmöç.",
    shift: "é!'^+%&/()=?_" + "QWERTYUIOPĞÜ" + "ASDFGHJKLŞİ;" + ">ZXCVBNMÖÇ:",
    altgr: "<>£#$½ {[]}\\|" + "@ €         " + "æß          " + "|          ",
  },
  "ja-jp-qwerty": {
    id: 0x411,
    base: " 1234567890-^" + "qwertyuiop@[" + "asdfghjkl;:]" + " zxcvbnm,./",
    shift: " !\"#$%&'() =~" + "QWERTYUIOP`{" + "ASDFGHJKL+*}" + " ZXCVBNM<>?",
    extra: [
      [0x73, "\\", "_"],
      [0x7d, "¥", "|"],
    ],
  },
};

export const DEFAULT_LAYOUT = "en-us-qwerty";
