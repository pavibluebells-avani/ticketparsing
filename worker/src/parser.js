// =====================================================
// LOTTERY MESSAGE PARSER (JS port of lottery_parser_v5.py)
// Runs inside Cloudflare Worker (V8 isolate) — no Node APIs.
// =====================================================

// ------------------------------------------------------
// LEXICON
// ------------------------------------------------------

const LOTTERY_ALIASES = {
    "dear": "DEAR", "dr": "DEAR", "deer": "DEAR", "d": "DEAR",
    "dear.": "DEAR", "dr.": "DEAR",
    "kerala": "KERALA", "kl": "KERALA", "k,l": "KERALA", "k.l": "KERALA",
    "kerla": "KERALA", "keral": "KERALA", "kl.": "KERALA",
    "goa": "GOA", "go": "GOA",
}

// Known group JIDs -> lottery type (per spec)
const GROUP_JID_LOTTERY = {
    "919894049974-1577513975@g.us": "DEAR", // Bala 494
    "120363039454928220@g.us": "DEAR",      // Bala 678
    "120363420312690777@g.us": "DEAR",      // Prem Ac Statement
}

const TIMESLOT_PATTERNS = [
    [/\b1\s*[.:]*\s*pm\b/i, "1PM"],
    [/\bpm\s*1\b/i, "1PM"],
    [/\b3\s*[.:]*\s*pm\b/i, "3PM"],
    [/\bpm\s*3\b/i, "3PM"],
    [/\b5\s*[.:]*\s*pm\b/i, "5PM"],
    [/\bpm\s*5\b/i, "5PM"],
    [/\b6\s*[.:]*\s*pm\b/i, "6PM"],
    [/\bpm\s*6\b/i, "6PM"],
    [/\b7\s*[.:]*\s*pm\b/i, "7PM"],
    [/\bpm\s*7\b/i, "7PM"],
    [/\b8\s*[.:]*\s*pm\b/i, "8PM"],
    [/\bpm\s*8\b/i, "8PM"],
    [/\b12\s*[.:]*\s*pm\b/i, "12PM"],
    [/\bpm\s*12\b/i, "12PM"],
    [/\b10\s*[.:]*\s*pm\b/i, "10PM"],
    [/\bpm\s*10\b/i, "10PM"],
]

const BET_TYPE_MAP = {
    "ab": "AB", "a.b": "AB", "a b": "AB",
    "bc": "BC", "b.c": "BC", "b c": "BC",
    "ac": "AC", "a.c": "AC", "a c": "AC",
    "abc": "ABC",
    "all": "ALL",
    "allbot": "ALL", "all board": "ALL", "allboard": "ALL",
    "full board": "ALL", "fullboard": "ALL",
    "board": "ALL", "bort": "ALL",
    "single": "SINGLE",
}

const RATE_PATTERN = /(?:rs|re|r\.s|r,s|r\s)[.,\s]*(\d+)/i
const RATE_SUFFIX_PATTERN = /(\d+)\s*(?:rs|re)\.?\b/i

const VALID_RATES = new Set([10, 12, 15, 20, 25, 30, 50, 60, 100, 650])

const SET_ALIASES = new Set(["set", "sets", "sat", "ser", "sett", "seat", "pcs", "pes"])
const EACH_ALIASES = new Set(["each", "ecsh", "ech", "eash", "ea"])
const BOX_ALIASES = new Set(["box", "bx"])

const SINGLE_DIGIT_POSITIONS = { "a": "A", "b": "B", "c": "C" }

// Groups to skip (statement/reporting) unless message has correction keywords
const SKIP_GROUPS = new Set(["statement", "reporting software"])

// Correction/dispute keywords — messages bypass skip-groups; unclassifiable ones → AMBIGUOUS
const CORRECTION_KW_RE = /\b(cancel|cancl|cansel|missing|miss|delete|remove|wrong|mistake|correct|change|replace|avoid|ignore|skip|not\s+required|dont\s+take|don't\s+take|no\s+need|reduce|deduct|cut)\b/i

// Timeslot → lottery inference (unique timeslot mappings)
const TIMESLOT_LOTTERY_MAP = {
    "3PM": "KERALA",
    "5PM": "GOA",
    "7PM": "GOA",
    "1PM": "DEAR",
    "6PM": "DEAR",
    "8PM": "DEAR",
}

// Bet-type keyword line regex (standalone line like "Ab", "Bc", "Board")
const BET_KW_LINE_RE = /^(?:ab|bc|ac|abc|all|board|bord|borad|bort|allbot|allbod|albert|abacbc|bcabac|full\s*board)\s*$/i

const NOISE_WORD_SET = new Set([
    'board', 'chance', 'quantity', 'entered', 'wrongly',
    'entry', 'done', 'ok', 'one', 'reporting', 'completed',
    'mistakes', 'corrected', 'sir', 'pls', 'please', '/-',
    '.', 'dear.', 'pm', 'full', 'half', 'super', 'doubles',
    'ji', 'va', 'jiii', 'missing', 'port', 'eh', 'but',
    'mentioned', 'report', 'not', 'the', 'is', 'it', 'in',
    'and', 'for', 'with', 'that', 'this', 'was', 'are',
    'be', 'has', 'have', 'had', 'at', 'by', 'no', 'yes',
    'me', 'my', 'we', 'you', 'he', 'she', 'its', 'our',
    'your', 'their', 'am', 'an', 'or', 'if', 'so', 'do',
    'up', 'on', 'of', 'only', 'just', 'also', 'very',
    'total', 'balance', 'pending', 'check', 'waiting',
    'cancel', 'actual', 'company', 'booking', 'mistake',
    'amount', 'payment', 'ticket', 'tickets', 'five', 'two', 'three',
    'four', 'six', 'seven', 'eight', 'nine', 'ten',
    'number', 'numbers', 'msg', 'message', 'received',
    ',', 'will', 'can', 'need',
    'wrong', 'change', 'instead', 'correction',
    'same', 'above', 'below', 'here', 'there',
    'bro', 'anna', 'enna', 'da', 'pa', 'ya', 'la',
    'poda', 'seri', 'illa', 'oru', 'ipo',
    'than', 'nee', 'nan', 'enga', 'inga', 'anga',
    'draw', 'correct', 'send', 'sended', 'statement',
    'winning', 'okay', 'degital', 'digital', 'degtel',
    'aii', 'bm', 'digit', '*', 'ignorenum',
    'ifsc', 'value', 'account', 'wait', 'double',
    'win', 'extra', 'enter', 'code', 'der',
    '-2', '-1', '-3', '-5', 'e', 'jii', 'bank',
    'cport', 'ail', 'dally',
    'nos', 'sent', 'bm60', 't', 'test', 'less',
    'miss', '&',
])

// Noise message patterns
const NOISE_PATTERNS = [
    /^$/,
    /^(entry done|reporting completed|mistakes corrected|ok|done|noted|received|ok done|entry|entries done|report done)$/i,
    /^(good morning|good night|hi|hello|thanks|thank you|one|gm|gn|okay|draw|correct|send|sended)$/i,
    /^[\u{1f600}-\u{1f64f}\u{1f300}-\u{1f5ff}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\s\u{1f44d}]+$/u,
    /^[^\x00-\x7F\d]+$/, // pure non-ASCII
    /^degtel/i,
    /^(statement|tickets?|winning|digital|degital|sended)\b/i,
]

// ------------------------------------------------------
// NORMALIZER
// ------------------------------------------------------

function normalizeSeparators(text) {
    if (!text) return ""
    // Unicode NFKC normalization — maps fancy unicode chars to plain ascii equivalents
    text = text.normalize('NFKC')

    // Collapse repeated dots/commas
    text = text.replace(/[.]{2,}/g, ' ')
    text = text.replace(/[,]{2,}/g, ' ')

    // Dot-separated numbers: "59.95.91.19" -> "59 95 91 19" (two passes for chains)
    text = text.replace(/(\d{2,5})\.(\d{2,5})/g, '$1 $2')
    text = text.replace(/(\d{2,5})\.(\d{2,5})/g, '$1 $2')

    // Equals as separator
    text = text.replace(/=+/g, ' ')
    // Multiple dashes
    text = text.replace(/-{2,}/g, ' ')
    // Colons
    text = text.replace(/:/g, ' ')

    // "dear.1" -> "dear 1"
    text = text.replace(/\b(dear|dr|kl|kerala|goa)\.(\d)/gi, '$1 $2')
    // "50." trailing dot -> "50 "
    text = text.replace(/(\d)\.(\s|$)/g, '$1 ')
    // "bc." "ac." trailing dot
    text = text.replace(/\b(ab|bc|ac|abc)\.\s/gi, '$1 ')
    // "rs," -> "rs"
    text = text.replace(/\b(rs|re),/gi, '$1')
    // "ea.1" -> "each 1"
    text = text.replace(/\bea\.(\d)/gi, 'each $1')
    // "-1set" -> " 1set" (not preceded by digit)
    text = text.replace(/(?<!\d)-(\d+(?:set|sat|ser))/gi, ' $1')
    // "4-5set" -> "4 5set"
    text = text.replace(/(\d)-(\d+(?:set|sat|ser|seat|pcs))/gi, '$1 $2')
    // "2.set" -> "2set"
    text = text.replace(/(\d)\.(?:set|sat|ser)/gi, '$1set')
    // Tamil rupee
    text = text.replace(/(\d+)ரூ/g, 'rs$1')
    text = text.replace(/ரூ(\d+)/g, 'rs$1')
    // "60-rs" -> "rs60"
    text = text.replace(/(\d+)\s*-\s*rs\b/gi, 'rs$1')
    // "8pm." -> "8pm"
    text = text.replace(/(\dpm)\./gi, '$1')
    // "8.pm" -> "8pm"
    text = text.replace(/(\d)\.pm/gi, '$1pm')
    // "rs30pm8" -> "rs30 8pm"
    text = text.replace(/\b(rs\d+)(pm)(\d)\b/gi, '$1 $3$2')
    // "dear8pm" -> "dear 8pm"
    text = text.replace(/\b(dear|dr|kl|kerala)([\d]+pm)/gi, '$1 $2')
    // "1sets" -> "1set"
    text = text.replace(/(\d+)sets\b/gi, '$1set')
    // "10stc" -> "10set"
    text = text.replace(/(\d+)stc\b/gi, '$1set')
    // "borad"/"bort" -> "board"
    text = text.replace(/\bborad\b/gi, 'board')
    text = text.replace(/\bbort\b/gi, 'board')
    // "board." trailing dot
    text = text.replace(/\bboard\./gi, 'board')
    // trailing comma on numbers
    text = text.replace(/(\d),(\s|$)/g, '$1 ')
    // Split compound tokens: "bc1set" -> "bc 1set"
    text = text.replace(/([a-zA-Z]{2,3})(\d+(?:set|sat|ser|seat))/gi, '$1 $2')
    // Split "Nrs.lottery": "25rs.dear" -> "25rs dear"
    text = text.replace(/(\d+rs)\.([a-zA-Z])/gi, '$1 $2')
    // Split "rs-N" -> "rsN"
    text = text.replace(/\b(rs|re)\s*-\s*(\d+)/gi, '$1$2')
    // "p1m" "p3m" -> "1pm" "3pm"
    text = text.replace(/\bp(\d{1,2})m\b/gi, '$1pm')
    // "pm8" -> "8pm"
    text = text.replace(/\bpm\.?(\d{1,2})\b/gi, '$1pm')
    // "10/-" -> "rs10"
    text = text.replace(/\b(\d+)\/-/g, 'rs$1')
    // "30.rs" -> "rs30"
    text = text.replace(/(\d+)\.rs\b/gi, 'rs$1')
    // "dear.rs.50" -> "dear rs50"
    text = text.replace(/\b(dear|dr|kl|kerala)\.(rs)\.(\d+)/gi, '$1 $2$3')
    // "rs30p6m" -> "rs30 6pm"
    text = text.replace(/(rs\d+)p(\d{1,2})m\b/gi, '$1 $2pm')
    // "dear6" "dr1" -> "dear 6pm" "dr 1pm" (lottery + bare timeslot digit)
    text = text.replace(/\b(dear|dr)[\s,]*(\d{1,2})(?!\d|pm|rs|set|sat|\.)/gi, '$1 $2pm')
    text = text.replace(/\b(kl|kerala)[\s,]*(\d{1,2})(?!\d|pm|rs|set|sat|\.)/gi, '$1 $2pm')
    // "abacbc" -> "ab ac bc"
    text = text.replace(/\babacbc\b/gi, 'ab ac bc')
    // "abcd" -> "all"
    text = text.replace(/\babcd\b/gi, 'all')
    // "5seat" -> "5set"
    text = text.replace(/(\d+)seat\b/gi, '$1set')
    // "pes" -> "pcs"
    text = text.replace(/\bpes\b/gi, 'pcs')
    // "1setdear" -> "1set dear"
    text = text.replace(/(\d+(?:set|sat|ser))\.*\s*(dear|dr|kl|kerala)/gi, '$1 $2')
    // "1set." trailing dot
    text = text.replace(/(\d+(?:set|sat|ser))\./gi, '$1')
    // "c." "b." "a." standalone -> strip trailing dot
    text = text.replace(/\b([abc])\.(?=\s|$)/gi, '$1')
    // "pm." trailing dot
    text = text.replace(/\bpm\.(?=\s|$)/gi, 'pm')
    // "abc0" "abc2" -> "abc 0" "abc 2"
    text = text.replace(/\b(abc)(\d+)\b/gi, '$1 $2')
    // "kl100" -> "kl rs100"
    text = text.replace(/\b(kl|kerala)(\d{2,3})(?!\d|pm)/gi, '$1 rs$2')
    // "kl," -> "kl"
    text = text.replace(/\b(kl|kerala|dear|dr),(?=\s|$)/gi, '$1')
    // "each-2" -> "each 2"
    text = text.replace(/\beach-(\d+)/gi, 'each $1')
    // "ecah" -> "each"
    text = text.replace(/\becah\b/gi, 'each')
    // "30₹" "₹30" -> "rs30"
    text = text.replace(/(\d+)₹/g, 'rs$1')
    text = text.replace(/₹(\d+)/g, 'rs$1')
    // "76.1set" -> "76 1set"
    text = text.replace(/(\d{2,5})\.(\d+(?:set|sat|ser))/gi, '$1 $2')
    // "-30rs" -> "rs30"
    text = text.replace(/-(\d+)rs\b/gi, 'rs$1')
    // "bc-002set" -> "bc 002 set"
    text = text.replace(/\b([abc]{2,3})-(\d+)(set|sat|ser)\b/gi, '$1 $2 $3')
    // "30rs-805,508" -> "rs30 805,508"
    text = text.replace(/\b(\d+)rs-(\d)/gi, 'rs$1 $2')
    // Comma-separated betting numbers BEFORE IGNORENUM
    text = text.replace(/\b(\d{2,5}),(\d{2,5})\b/g, '$1 $2')
    text = text.replace(/\b(\d{2,5}),(\d{2,5})\b/g, '$1 $2')
    // Large comma numbers like "50,000" -> IGNORENUM
    text = text.replace(/\b\d{1,3},\d{3}\b/g, 'IGNORENUM')
    text = text.replace(/IGNORENUM[,\s]*IGNORENUM/g, 'IGNORENUM')
    // "bcabac" -> "bc ab ac"
    text = text.replace(/\bbcabac\b/gi, 'bc ab ac')
    text = text.replace(/\babacbc\b/gi, 'ab ac bc')
    text = text.replace(/\babbc\b/gi, 'ab bc')
    text = text.replace(/\bacbc\b/gi, 'ac bc')
    text = text.replace(/\babac\b/gi, 'ab ac')
    // "(box)" -> "box"
    text = text.split('(box)').join('box').split('(BOX)').join('box')
    // "bcrs12" -> "bc rs12"
    text = text.replace(/\b([abc]{2,3})(rs\d+)/gi, '$1 $2')
    // "30rupise" "30rupees" -> "rs30"
    text = text.replace(/(\d+)\s*(?:rupise|rupees|rupee|rupi)\b/gi, 'rs$1')
    // "kl,rs30" -> "kl rs30"
    text = text.replace(/\b(kl|kerala|dear|dr),(rs\d+)/gi, '$1 $2')
    // "dear/8pm/rs.30" -> "dear 8pm rs30"
    text = text.replace(/([a-zA-Z])\/(\d)/g, '$1 $2')
    text = text.replace(/(\d)\/([a-zA-Z])/g, '$1 $2')
    text = text.replace(/([a-zA-Z])\/([a-zA-Z])/g, '$1 $2')
    // "der" -> "dear"
    text = text.replace(/\bder\b/gi, 'dear')
    // "each." -> "each"
    text = text.replace(/\beach\./gi, 'each')
    // "pm," -> "pm"
    text = text.replace(/\bpm,/gi, 'pm')
    // "1pmmp" -> "1pm"
    text = text.replace(/(\d)pmmp\b/gi, '$1pm')
    // "all." -> "all"
    text = text.replace(/\ball\./gi, 'all')
    // "10pic" -> "10pcs"
    text = text.replace(/(\d+)pic\b/gi, '$1pcs')
    // "allbod" -> "allbot"
    text = text.replace(/\ballbod\b/gi, 'allbot')
    // "abc-00" -> "abc 0"
    text = text.replace(/\babc-00?\b/gi, 'abc 0')
    // "dear-1pm" -> "dear 1pm"
    text = text.replace(/\b(dear|dr|kl|kerala)-(\d+pm)/gi, '$1 $2')
    // "1pm." -> "1pm"
    text = text.replace(/(\dpm)\./gi, '$1')
    // "4,set" -> "4set"
    text = text.replace(/(\d+),\s*(?:set|sat|ser)/gi, '$1set')
    // "30ru" -> "rs30"
    text = text.replace(/(\d+)ru\b/gi, 'rs$1')
    // "527x1" "527×1" -> "527*1"
    text = text.replace(/(\d+)[x×](\d+)/gi, '$1*$2')
    // Standalone "×2" -> "*2"
    text = text.replace(/×(\d+)/g, '*$1')
    // "×2nos" -> "*2"
    text = text.replace(/[×x](\d+)\s*nos\b/gi, '*$1')
    // "35.1" -> "35-1" (number.qty pattern, 2-5 digit . single digit)
    text = text.replace(/\b(\d{2,5})\.(\d)(?=\s|$)/g, '$1-$2')
    // "38/83(5)pcs" -> "38 83 5pcs"
    text = text.replace(/\((\d+)\)(pcs|set|sat|ser)/gi, ' $1$2')
    text = text.split('(').join(' ').split(')').join(' ')
    // "8,pm" -> "8pm"
    text = text.replace(/(\d),pm\b/gi, '$1pm')
    // "1.00pm" -> "1pm"
    text = text.replace(/(\d)\.00pm\b/gi, '$1pm')
    // "each3" -> "each 3"
    text = text.replace(/\beach(\d)/gi, 'each $1')
    // "b0x" -> "box"
    text = text.replace(/\bb0x\b/gi, 'box')
    // "5st" -> "5set"
    text = text.replace(/(\d+)st\b/gi, '$1set')
    // "set." -> "set"
    text = text.replace(/\bset\./gi, 'set')
    // "b-9" -> "b 9"
    text = text.replace(/\b([abc])-(\d)/gi, '$1 $2')
    // "38/83" -> "38 83"
    text = text.replace(/\b(\d{2,5})\/(\d{2,5})\b/g, '$1 $2')
    // "dl" -> "dear"
    text = text.replace(/\bdl\b/gi, 'dear')
    // "ac-35" -> "ac 35"
    text = text.replace(/\b([abc]{2,3})-(\d{1,5})\b/gi, '$1 $2')
    // "eech" -> "each"
    text = text.replace(/\beech\b/gi, 'each')
    // "1set," -> "1set"
    text = text.replace(/(\d+(?:set|sat|ser)),/gi, '$1')
    // "1pmrs30" -> "1pm rs30"
    text = text.replace(/(\dpm)(rs\d+)/gi, '$1 $2')
    // "rs.100.3pm" -> "rs100 3pm"
    text = text.replace(/(rs\.?\d+)\.(\dpm)/gi, '$1 $2')
    // ".45" -> " 45"
    text = text.replace(/(^|\s)\.(\d)/g, '$1 $2')
    // "-30" standalone rate -> "rs30"
    text = text.replace(/(^|\s)-(\d+)(?=\s|$)/g, '$1 rs$2')
    // "ab,bc,ac" "ab-ac" -> split
    text = text.replace(/\b(ab|ac|bc)[,\-](ab|ac|bc)(?:[,\-](ab|ac|bc))?/gi, (m, a, b, c) => [a, b, c].filter(Boolean).join(' '))
    // "8pmrs.100" -> "8pm rs100"
    text = text.replace(/(\dpm)(rs\.?\d+)/gi, '$1 $2')
    // "e3set" -> "each 3set"
    text = text.replace(/\be(\d+)(set|sat|ser)/gi, 'each $1$2')
    // "30rupice" -> "rs30"
    text = text.replace(/(\d+)\s*(?:rupice|rupise|rupees|rupee|rupi|ru)\b/gi, 'rs$1')
    // "depr" -> "dear"
    text = text.replace(/\bdepr\b/gi, 'dear')
    // "k.l" -> "kl"
    text = text.replace(/\bk\.l\b/gi, 'kl')
    // "0.5set" handled above via number.Nset rule
    // "6.00" -> "6"
    text = text.replace(/(\d)\.00\b/g, '$1')
    // Re-apply comma-separated split
    text = text.replace(/\b(\d{2,5}),(\d{2,5})\b/g, '$1 $2')
    // "klrs60" -> "kl rs60"
    text = text.replace(/\b(kl|kerala|dear|dr)(rs\.?\d+)/gi, '$1 $2')
    // "kl.rs.100" -> "kl rs100"
    text = text.replace(/\b(kl|kerala|dear|dr)\.(rs)\.(\d+)/gi, '$1 $2$3')
    // "58,85each" -> "58 85 each"
    text = text.replace(/(\d{2,5}),(\d{2,5})(each)/gi, '$1 $2 $3')
    // "_2set" -> "2set"
    text = text.replace(/_(\d)/g, '$1')
    // "1,pmrs30" -> "1pm rs30"
    text = text.replace(/(\d),pm/gi, '$1pm')
    // "00/2set" -> "00 2set"
    text = text.replace(/(\d+)\/(\d+(?:set|sat|ser))/gi, '$1 $2')
    // "92+2set" -> "92 2set"
    text = text.replace(/(\d+)\+(\d+(?:set|sat|ser))/gi, '$1 $2')
    // "61+5sed" -> "61 5set"
    text = text.replace(/(\d+)sed\b/gi, '$1set')
    // "8.5set" -> "8 5set"
    text = text.replace(/\b(\d+)\.(\d+(?:set|sat|ser))/gi, '$1 $2')
    // "10.se" -> "10set"
    text = text.replace(/(\d+)\.se\b/gi, '$1set')
    // "0.5set" -> "0 5set"
    text = text.replace(/\b(\d)\.(\d+set)/gi, '$1 $2')
    // "5,6" -> "5 6"
    text = text.replace(/\b(\d),(\d)\b/g, '$1 $2')
    // "ac," "ac-" -> strip trailing
    text = text.replace(/\b(ab|ac|bc|abc)[,\-](?=\s|$)/gi, '$1')
    // "ac,80" -> "ac 80"
    text = text.replace(/\b(ab|ac|bc|abc),(\d)/gi, '$1 $2')
    // "c,8" -> "c 8"
    text = text.replace(/\b([abc]),(\d)/gi, '$1 $2')
    // "r100" -> "rs100"
    text = text.replace(/\br(\d{2,3})\b/gi, 'rs$1')
    // "1pmrs30" reapply
    text = text.replace(/(\dpm)(rs\.?\d+)/gi, '$1 $2')
    // "61+5set" -> "61 5set"
    text = text.replace(/(\d+)\+(\d+set)/gi, '$1 $2')
    // ".set" -> "set"
    text = text.replace(/(^|\s)\.set\b/gi, ' set')
    // "058,-1" -> "058 -1"
    text = text.replace(/(\d+),(-\d)/g, '$1 $2')
    // "&" -> noise
    text = text.split('&').join(' ')
    // "_" -> noise
    text = text.split('_').join(' ')
    // Final space normalize
    text = text.replace(/\s+/g, ' ')
    return text.trim()
}

// ------------------------------------------------------
// NOISE FILTER
// ------------------------------------------------------

function isNoise(text) {
    const cleaned = (text || "").trim()
    if (!cleaned) return true
    for (const pat of NOISE_PATTERNS) {
        if (pat.test(cleaned)) return true
    }
    // Pure emoji / non-ascii messages
    let allNonAscii = true
    for (const c of cleaned) {
        if (!(c.codePointAt(0) > 127 || /\s/.test(c))) {
            allNonAscii = false
            break
        }
    }
    if (allNonAscii) return true
    return false
}

// ------------------------------------------------------
// LOTTERY DETECTION
// ------------------------------------------------------

function detectLotteryFromGroup(groupName, groupJid) {
    if (groupJid && GROUP_JID_LOTTERY[groupJid]) {
        return GROUP_JID_LOTTERY[groupJid]
    }
    const gn = (groupName || "").toLowerCase()
    if (gn.includes("dear")) return "DEAR"
    if (gn.includes("kerala") || gn.includes("kl")) return "KERALA"
    if (gn.includes("goa")) return "GOA"
    return null
}

function detectLotteryFromText(text) {
    const lower = (text || "").toLowerCase()
    for (const [alias, canonical] of Object.entries(LOTTERY_ALIASES)) {
        const re = new RegExp('(?:^|[\\s.,])' + escapeRegExp(alias) + '(?:[\\s.,]|$)', 'i')
        if (re.test(lower)) return canonical
    }
    return null
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------
// TIMESLOT DETECTION
// ------------------------------------------------------

function detectTimeslot(text) {
    for (const [pattern, slot] of TIMESLOT_PATTERNS) {
        if (pattern.test(text)) return slot
    }
    return null
}

// ------------------------------------------------------
// RATE EXTRACTION
// ------------------------------------------------------

function extractRate(text) {
    let m = RATE_PATTERN.exec(text)
    if (m) {
        const val = parseInt(m[1], 10)
        if (VALID_RATES.has(val)) return val
    }
    m = RATE_SUFFIX_PATTERN.exec(text)
    if (m) {
        const val = parseInt(m[1], 10)
        if (VALID_RATES.has(val)) return val
    }
    return null
}

// ------------------------------------------------------
// BET TYPE DETECTION
// ------------------------------------------------------

function detectBetType(text) {
    const cleaned = (text || "").toLowerCase().trim()
    if (BET_TYPE_MAP[cleaned]) return BET_TYPE_MAP[cleaned]
    const tokens = cleaned.split(/[\s.,]+/)
    for (const t of tokens) {
        if (BET_TYPE_MAP[t]) return BET_TYPE_MAP[t]
    }
    return null
}

// ------------------------------------------------------
// CATEGORY DERIVATION
// ------------------------------------------------------

function deriveCategory(number, rate, betType) {
    const dlen = number.length

    if (dlen === 1) return "SINGLE"

    if (dlen === 2) {
        if (rate === 60) return "FULL"
        if (rate === 30) return "HALF"
        return "AB_BC_AC"
    }

    if (dlen === 3) {
        if (rate === 10) return "3D10"
        if (rate === 25) return "3D25"
        if (rate === 30) return "3D_HALF"
        return "3D_FULL"
    }

    if (dlen === 4) {
        if (rate === 20) return "4D20"
        if (rate === 50) return "4D50"
        if (rate === 100) return "4D100"
        return "4D100"
    }

    if (dlen === 5) return "5D"

    return "UNKNOWN"
}

function getDefaultRate(numLen) {
    const defaults = { 1: 12, 2: 12, 3: 60, 4: 100, 5: 650 }
    return defaults[numLen] || 0
}

// ------------------------------------------------------
// NUMBER-QTY REGEX PATTERNS
// ------------------------------------------------------

const RE_NUM_QTY_STAR = /^(\d{1,5})\s*\*\s*(\d+)$/
const RE_NUM_QTY_DASH = /^(\d{1,5})\s*-\s*(\d+)$/
const RE_NUM_QTY_SLASH = /^(\d{1,5})\s*\/\s*(\d+)$/
const RE_NUM_QTY_DOT = /^(\d{1,5})\.(\d+)\.(?:sat|set|ser)$/i
const RE_NUM_QTY_PLUS = /^(\d{1,5})\+(\d+)$/
const RE_STANDALONE_NUM = /^(\d{1,5})$/

// ------------------------------------------------------
// LINE PARSER
// ------------------------------------------------------

function parseLine(rawLine, ctx) {
    const entries = []
    const originalLine = rawLine
    let line = normalizeSeparators(rawLine)
    let lineLower = line.toLowerCase().trim()

    if (!lineLower) return entries

    // --- Detect and update context from this line ---

    // Lottery detection
    for (const [alias, canonical] of Object.entries(LOTTERY_ALIASES)) {
        const re = new RegExp('(?:^|[\\s.,])' + escapeRegExp(alias) + '(?:[\\s.,]|$)', 'i')
        if (re.test(lineLower)) {
            ctx.lottery = canonical
            break
        }
    }

    // Timeslot detection
    const ts = detectTimeslot(line)
    if (ts) ctx.timeslot = ts

    // Rate detection
    const rate = extractRate(line)
    if (rate) ctx.rate = rate

    // Date line: "30...5...2026"
    const dateMatch = /^\s*(\d{1,2})\s*[./\s]+(\d{1,2})\s*[./\s]+(\d{4})\s*$/.exec(line)
    if (dateMatch) {
        ctx.date_str = `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`
        return entries
    }

    // Bet type detection
    const bt = detectBetType(line)
    if (bt) {
        const numsInLine = line.match(/\b\d{1,5}\b/g) || []
        const nonRateNums = numsInLine.filter(n => !VALID_RATES.has(parseInt(n, 10)))
        if (nonRateNums.length === 0) {
            ctx.bet_type = bt
            return entries
        }
        ctx.bet_type = bt
    }

    // Single position headers "A", "B", "C"
    const singlePosMatch = /^([abc])\s*$/.exec(lineLower)
    if (singlePosMatch) {
        ctx.bet_type = singlePosMatch[1].toUpperCase()
        return entries
    }

    // Detect "each N set" / "N set" and strip so qty tokens don't become bet numbers
    let eachQty = null
    let eachStripMatch = null
    for (const ea of EACH_ALIASES) {
        const re = new RegExp(`\\b${ea}\\s*(\\d+)\\s*(?:set|sat|ser|seat|pcs|pes)?\\b`, 'i')
        const m = re.exec(lineLower)
        if (m) {
            eachQty = parseInt(m[1], 10)
            eachStripMatch = m
            break
        }
    }
    if (eachQty === null) {
        const m = /\b(\d+)\s*(?:set|sat|ser|seat|pcs|pes)\s*(?:each)?\b/i.exec(lineLower)
        if (m) {
            eachQty = parseInt(m[1], 10)
            eachStripMatch = m
        }
    }
    if (eachQty === null) {
        const m = /\beach\s*-?\s*(\d+)/i.exec(lineLower)
        if (m) {
            eachQty = parseInt(m[1], 10)
            eachStripMatch = m
        }
    }
    if (eachStripMatch) {
        const start = eachStripMatch.index
        const end = start + eachStripMatch[0].length
        line = line.slice(0, start) + ' ' + line.slice(end)
        lineLower = line.toLowerCase()
    }

    // Inline rate+numbers pattern: "RS.30.631.845.467"
    const rateNumsMatch = /^(?:rs|re)\.?(\d+)\.(\d[\d.]+)$/i.exec(line.trim())
    if (rateNumsMatch) {
        ctx.rate = parseInt(rateNumsMatch[1], 10)
        const numsStr = rateNumsMatch[2]
        const nums = numsStr.split(/[.\s]+/).filter(n => n && /^\d+$/.test(n))
        for (const num of nums) {
            if (num.length >= 2) {
                const effectiveRate = ctx.rate || getDefaultRate(num.length)
                const effectiveQty = eachQty || 1
                entries.push(makeEntry(num, ctx.bet_type, effectiveQty, effectiveRate, ctx, originalLine))
            }
        }
        return entries
    }

    // Tokenize
    const tokens = line.trim().split(/\s+/)
    let i = 0

    while (i < tokens.length) {
        const tok = (tokens[i] || "").trim()
        const tokLower = tok.toLowerCase()

        if (!tok) { i++; continue }

        // Pure non-ASCII token
        if (isAllNonAsciiToken(tok)) { i++; continue }

        // IGNORENUM
        if (tokLower.includes('ignorenum')) { i++; continue }

        // Pure context tokens already processed
        if (LOTTERY_ALIASES[tokLower] !== undefined || tokLower === 'rs' || tokLower === 're' || tokLower === 'pm' || tokLower === 'rs.' || tokLower === 're.') {
            i++; continue
        }

        // Bet type tokens inline
        if (BET_TYPE_MAP[tokLower]) {
            ctx.bet_type = BET_TYPE_MAP[tokLower]
            i++; continue
        }

        // Single position tokens
        if (SINGLE_DIGIT_POSITIONS[tokLower]) {
            ctx.bet_type = SINGLE_DIGIT_POSITIONS[tokLower]
            i++; continue
        }

        // "4d" context marker
        if (/^\d+d$/.test(tokLower)) { i++; continue }

        // Known noise/modifier tokens
        if (SET_ALIASES.has(tokLower) || EACH_ALIASES.has(tokLower) || BOX_ALIASES.has(tokLower) || NOISE_WORD_SET.has(tokLower)) {
            i++; continue
        }

        // qty compound tokens: "1set" "2sat" etc.
        if (/^\d+\s*(?:set|sat|ser|sett|seat|pcs|pes)$/.test(tokLower)) { i++; continue }

        // "to" keyword
        if (tokLower === 'to') { i++; continue }

        // Standalone "*N" qty modifier applies to last entry
        const starQtyMatch = /^\*(\d+)(?:nos)?$/.exec(tokLower)
        if (starQtyMatch) {
            const qtyVal = parseInt(starQtyMatch[1], 10)
            if (entries.length && qtyVal <= 20) {
                entries[entries.length - 1].qty = qtyVal
            }
            i++; continue
        }

        // "nos" standalone
        if (tokLower === 'nos' || tokLower === 'no.s' || tokLower === 'no') { i++; continue }

        // Number*qty
        let m = RE_NUM_QTY_STAR.exec(tok)
        if (m) {
            const num = m[1], qty = parseInt(m[2], 10)
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
            i++; continue
        }

        // Number-qty dash: 364-2 (or same-length dash-split like 56-65)
        m = RE_NUM_QTY_DASH.exec(tok)
        if (m) {
            const num = m[1], qtyStr = m[2]
            const qty = parseInt(qtyStr, 10)
            if (num.length >= 2 && qtyStr.length === num.length && qty > 20) {
                for (const n of [num, qtyStr]) {
                    const effectiveRate = ctx.rate || getDefaultRate(n.length)
                    entries.push(makeEntry(n, ctx.bet_type, eachQty || 1, effectiveRate, ctx, originalLine))
                }
                i++; continue
            }
            if (qty <= 20) {
                const effectiveRate = ctx.rate || getDefaultRate(num.length)
                entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
                i++; continue
            }
        }

        // Number/qty slash
        m = RE_NUM_QTY_SLASH.exec(tok)
        if (m) {
            const num = m[1], qty = parseInt(m[2], 10)
            if (qty <= 20) {
                const effectiveRate = ctx.rate || getDefaultRate(num.length)
                entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
                i++; continue
            }
        }

        // Number.qty.set
        m = RE_NUM_QTY_DOT.exec(tok)
        if (m) {
            const num = m[1], qty = parseInt(m[2], 10)
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
            i++; continue
        }

        // Number+qty
        m = RE_NUM_QTY_PLUS.exec(tok)
        if (m) {
            const num = m[1], qty = parseInt(m[2], 10)
            if (qty <= 20) {
                const effectiveRate = ctx.rate || getDefaultRate(num.length)
                entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
                i++; continue
            }
        }

        // Number/box -> box: expand permutations skipped for perf/simplicity (kept as single entry marked bet_type BOX)
        m = /^(\d{1,5})\s*[/\-.]?\s*box$/i.exec(tok)
        if (m) {
            const num = m[1]
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            for (const bn of expandBox(num)) {
                entries.push(makeEntry(bn, ctx.bet_type, eachQty || 1, effectiveRate, ctx, originalLine, true))
            }
            i++; continue
        }

        // number followed by "box" token
        if (RE_STANDALONE_NUM.test(tok) && i + 1 < tokens.length && BOX_ALIASES.has((tokens[i + 1] || "").toLowerCase().replace(/[.,]+$/, ''))) {
            const num = tok
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            for (const bn of expandBox(num)) {
                entries.push(makeEntry(bn, ctx.bet_type, eachQty || 1, effectiveRate, ctx, originalLine, true))
            }
            i += 2; continue
        }

        // BetType.Numbers multi pattern: "Bc.47.24.86.45"
        const btMultiMatch = /^([abc]{1,3})\.(.+)$/i.exec(tok)
        if (btMultiMatch) {
            const btStr = btMultiMatch[1].toUpperCase()
            const rest = btMultiMatch[2]
            const nums = rest.split(/[.\s]+/).filter(n => n && /^\d+$/.test(n))
            if (nums.length && btStr.length <= 3) {
                for (const num of nums) {
                    const effectiveRate = ctx.rate || getDefaultRate(num.length)
                    entries.push(makeEntry(num, btStr, eachQty || 1, effectiveRate, ctx, originalLine))
                }
                i++; continue
            }
        }

        // Rate token
        if (/^(?:rs|re)\.?\d+$/i.test(tokLower) || /^\d+(?:rs|re)\.?$/i.test(tokLower)) { i++; continue }

        // Timeslot token
        if (/^\d+pm\d?$/.test(tokLower) || tokLower === 'pm') { i++; continue }

        // BetType+number: "Ac40" "Ab43"
        const btNumMatch = /^([abc]{2})(\d+)$/i.exec(tokLower)
        if (btNumMatch) {
            const btStr = btNumMatch[1].toUpperCase()
            const num = btNumMatch[2]
            let qty = eachQty || 1
            if (i + 1 < tokens.length) {
                const nxt = (tokens[i + 1] || "").toLowerCase().trim()
                const qtyM = /^(\d+)\s*(?:set|sat|ser)$/.exec(nxt)
                if (qtyM) { qty = parseInt(qtyM[1], 10); i++ }
            }
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            entries.push(makeEntry(num, btStr, qty, effectiveRate, ctx, originalLine))
            i++; continue
        }

        // Single position + number: "A4" "B3" "C0"
        const spMatch = /^([abc])(\d+)$/i.exec(tokLower)
        if (spMatch) {
            const btStr = spMatch[1].toUpperCase()
            const num = spMatch[2]
            let qty = eachQty || 1
            if (i + 1 < tokens.length) {
                const nxt = (tokens[i + 1] || "").toLowerCase().trim()
                const qtyM = /^(\d+)\s*(?:set|sat|ser)$/.exec(nxt)
                if (qtyM) { qty = parseInt(qtyM[1], 10); i++ }
            }
            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            entries.push(makeEntry(num, btStr, qty, effectiveRate, ctx, originalLine))
            i++; continue
        }

        // Standalone number
        m = RE_STANDALONE_NUM.exec(tok)
        if (m) {
            const num = m[1]
            const numVal = parseInt(num, 10)

            // "abc0" shortcut
            if (num === '0' && ctx.bet_type === 'ABC') {
                ctx.rate = 10
                i++; continue
            }

            if (!ctx.bet_type && VALID_RATES.has(numVal)) { i++; continue }
            if (!ctx.bet_type && (numVal === 2026 || numVal === 2025)) { i++; continue }

            if (num.length === 1 && !ctx.bet_type) {
                i++; continue
            }

            let qty = eachQty || 1
            if (i + 1 < tokens.length) {
                const nxt = (tokens[i + 1] || "").toLowerCase().trim()
                const qtyM = /^(\d+)\s*(?:set|sat|ser)$/.exec(nxt)
                if (qtyM) { qty = parseInt(qtyM[1], 10); i++ }
            }

            const effectiveRate = ctx.rate || getDefaultRate(num.length)
            entries.push(makeEntry(num, ctx.bet_type, qty, effectiveRate, ctx, originalLine))
            i++; continue
        }

        // Unknown token — skip
        i++
    }

    // Apply ALL / ABC expansion
    const expanded = []
    for (const entry of entries) {
        if (entry.betType === "ALL" || entry.betType === "ABC") {
            const dlen = entry.number.length
            if (dlen === 1) {
                for (const bt2 of ["A", "B", "C"]) expanded.push({ ...entry, betType: bt2 })
            } else if (dlen === 2) {
                for (const bt2 of ["AB", "AC", "BC"]) expanded.push({ ...entry, betType: bt2 })
            } else {
                expanded.push(entry)
            }
        } else {
            expanded.push(entry)
        }
    }

    return expanded
}

function isAllNonAsciiToken(tok) {
    for (const c of tok) {
        const code = c.codePointAt(0)
        if (!(code > 127 || !c.trim())) return false
    }
    return true
}

function expandBox(number) {
    // Generate unique permutations of the number's digits
    const perms = new Set()
    const chars = number.split('')
    permute(chars, 0, perms)
    return Array.from(perms).sort()
}

function permute(arr, k, out) {
    if (k === arr.length - 1) {
        out.add(arr.join(''))
        return
    }
    const seen = new Set()
    for (let i = k; i < arr.length; i++) {
        if (seen.has(arr[i])) continue
        seen.add(arr[i])
        ;[arr[k], arr[i]] = [arr[i], arr[k]]
        permute(arr, k + 1, out)
        ;[arr[k], arr[i]] = [arr[i], arr[k]]
    }
}

function makeEntry(number, betType, qty, rate, ctx, rawLine, isBox) {
    return {
        number,
        betType: betType || null,
        qty: qty || 1,
        rate: rate || null,
        category: deriveCategory(number, rate, betType),
        lottery: ctx.lottery,
        timeslot: ctx.timeslot,
        isBox: !!isBox,
        rawLine,
    }
}

// ------------------------------------------------------
// SECTION SPLITTING (ported from parse_bets_v2.py)
// ------------------------------------------------------

function extractRateFromLine(line) {
    // Extract a valid rate from a single line
    const patterns = [
        /(?:rs|re|ra|ரூ|₹|௹)[=.,/\s\-\(\{\[]*(\d{2,3})(?=\b|[a-zA-Z])/gi,
        /\b(\d{2,3})[./,\s]*(?:rs|re|ra|ரூ|₹|௹)/gi,
        /(?:dear|dr|deer|der|dl|deat|kl|kerala|kerela|goa)[.\s]*(\d{2,3})(?=\b|[a-zA-Z.\d])/gi,
    ]
    for (const re of patterns) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(line)) !== null) {
            const v = parseInt(m[1], 10)
            if (VALID_RATES.has(v)) return v
        }
    }
    return 0
}

function splitIntoSections(text) {
    // Returns array of { text, rate, flag }
    // flag: 'NUM_QTY_RATE' | null
    const lines = text.split('\n')

    // Check standalone "number,qty\nrate" pattern
    const nonEmpty = lines.map(l => l.trim()).filter(Boolean)
    if (nonEmpty.length === 2) {
        const m = /^(\d{2,5})\s*,\s*(\d{1,2})$/.exec(nonEmpty[0])
        if (m) {
            const rateVal = parseInt(nonEmpty[1], 10)
            if (VALID_RATES.has(rateVal)) {
                return [{ text, rate: rateVal, flag: 'NUM_QTY_RATE' }]
            }
        }
    }

    // Phase 1: assign rate to each line
    const lineRates = lines.map(l => extractRateFromLine(l))

    // Phase 2: split on rate transitions, bet-type keyword lines, digit-length changes after gaps
    const sections = []
    let curRate = 0
    let curStart = 0
    let gapSeen = false

    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim()

        if (!stripped) {
            gapSeen = true
            continue
        }

        // Rate change → new section
        if (lineRates[i] > 0 && lineRates[i] !== curRate) {
            if (i > curStart) {
                const secText = lines.slice(curStart, i).join('\n').trim()
                if (secText && /\d{2,5}/.test(secText)) {
                    sections.push({ text: secText, rate: curRate })
                }
            }
            curRate = lineRates[i]
            curStart = i
            gapSeen = false
            continue
        }

        // Bet-type keyword line after numeric content → new section
        if (BET_KW_LINE_RE.test(stripped) && i > curStart) {
            const beforeText = lines.slice(curStart, i).join('\n').trim()
            if (beforeText && /\d{2,5}/.test(beforeText)) {
                sections.push({ text: beforeText, rate: curRate })
                curStart = i
                curRate = 0
                gapSeen = false
                continue
            }
        }

        // Digit-length transition after gap (no explicit rate change)
        if (gapSeen && curRate === 0 && i > curStart) {
            const beforeText = lines.slice(curStart, i).join('\n')
            const beforeNums = beforeText.match(/\b\d{2,5}\b/g) || []
            const afterNums = stripped.match(/\b\d{2,5}\b/g) || []

            if (beforeNums.length && afterNums.length) {
                const beforeLens = new Set(beforeNums.map(n => n.length))
                const afterLens = new Set(afterNums.map(n => n.length))
                let overlap = false
                for (const l of beforeLens) { if (afterLens.has(l)) { overlap = true; break } }
                if (!overlap) {
                    const secText = lines.slice(curStart, i).join('\n').trim()
                    if (secText && /\d{2,5}/.test(secText)) {
                        sections.push({ text: secText, rate: curRate })
                    }
                    curStart = i
                    curRate = 0
                }
            }
        }

        if (stripped) gapSeen = false
    }

    // Flush last section
    const lastText = lines.slice(curStart).join('\n').trim()
    if (lastText && /\d{2,5}/.test(lastText)) {
        sections.push({ text: lastText, rate: curRate })
    }

    if (!sections.length) {
        return [{ text, rate: 0, flag: null }]
    }

    // Phase 3: sub-split no-rate sections with mixed digit lengths
    const final = []
    for (const sec of sections) {
        if (sec.rate === 0) {
            const sub = subSplitByDigitLength(sec.text)
            if (sub.length > 1) {
                for (const s of sub) final.push({ text: s.text, rate: s.rate, flag: null })
            } else {
                final.push({ text: sec.text, rate: sec.rate, flag: null })
            }
        } else {
            final.push({ text: sec.text, rate: sec.rate, flag: null })
        }
    }

    return final.length ? final : [{ text, rate: 0, flag: null }]
}

function subSplitByDigitLength(text) {
    const DEFAULT_RATES = { 2: 12, 3: 60, 4: 100, 5: 650 }
    const lines = text.split('\n')
    const groups = []
    let curLines = []
    let curDlen = 0

    for (const line of lines) {
        const stripped = line.trim()
        const nums = (stripped.match(/\b\d{2,5}\b/g) || []).filter(n => !(n.startsWith('202') && n.length === 4))
        if (!nums.length) {
            curLines.push(line)
            continue
        }

        // Mode of digit lengths on this line
        const lens = nums.map(n => n.length)
        const freq = {}
        for (const l of lens) freq[l] = (freq[l] || 0) + 1
        const lineDlen = parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0], 10)

        if (curDlen === 0) {
            curDlen = lineDlen
            curLines.push(line)
        } else if (lineDlen === curDlen) {
            curLines.push(line)
        } else {
            if (curLines.length) groups.push({ text: curLines.join('\n').trim(), dlen: curDlen })
            curLines = [line]
            curDlen = lineDlen
        }
    }
    if (curLines.length) groups.push({ text: curLines.join('\n').trim(), dlen: curDlen })

    const result = []
    for (const g of groups) {
        if (/\d{2,5}/.test(g.text)) {
            result.push({ text: g.text, rate: DEFAULT_RATES[g.dlen] || 0 })
        }
    }
    return result.length ? result : [{ text, rate: 0 }]
}

// ------------------------------------------------------
// SKIP GROUP CHECK
// ------------------------------------------------------

function shouldSkipGroup(groupName) {
    if (!groupName) return false
    const gl = groupName.toLowerCase()
    for (const sg of SKIP_GROUPS) {
        if (gl.includes(sg)) return true
    }
    return false
}

// ------------------------------------------------------
// TIMESLOT → LOTTERY INFERENCE
// ------------------------------------------------------

function inferLotteryFromTimeslot(timeslot) {
    return TIMESLOT_LOTTERY_MAP[timeslot] || null
}

// ------------------------------------------------------
// MESSAGE PARSER
// ------------------------------------------------------

// Cross-message context: tracks last lottery/timeslot per group
// In Worker context, this is reset per request batch (stateless per isolate invocation)
// For persistent context, store in D1 and pass in
const recentByGroup = new Map()

function parseMessage(text, groupName, groupJid, messageId, timestamp, sender, pushName) {
    const result = { lottery: null, timeslot: null, entries: [], sections: [], isNoise: false, isAmbiguous: false, isCorrection: false }

    if (!text || isNoise(text)) {
        result.isNoise = true
        return result
    }

    // Check for correction keywords
    const isCorrection = CORRECTION_KW_RE.test(text)
    result.isCorrection = isCorrection

    // Skip excluded groups unless message has correction keywords
    if (!isCorrection && shouldSkipGroup(groupName)) {
        result.isNoise = true
        return result
    }

    const ctx = {
        lottery: detectLotteryFromGroup(groupName, groupJid),
        timeslot: null,
        rate: null,
        bet_type: null,
        date_str: null,
    }

    // If no lottery from group, try text
    if (!ctx.lottery) {
        ctx.lottery = detectLotteryFromText(text)
    }

    // Detect timeslot from text
    ctx.timeslot = detectTimeslot(text)

    // Timeslot → lottery inference (if still no lottery)
    if (!ctx.lottery && ctx.timeslot) {
        ctx.lottery = inferLotteryFromTimeslot(ctx.timeslot)
    }

    // Cross-message context: inherit lottery from previous message in same group
    if (!ctx.lottery && groupJid && recentByGroup.has(groupJid)) {
        ctx.lottery = recentByGroup.get(groupJid)
    }

    // Update recent lottery for this group (only from text-detected lottery)
    const textLottery = detectLotteryFromText(text)
    if (textLottery && groupJid) {
        recentByGroup.set(groupJid, textLottery)
    }

    // 12PM ambiguity: text says "12pm" but no explicit lottery → ambiguous
    const is12pmAmbiguous = (ctx.timeslot === '12PM' && !detectLotteryFromText(text))

    // Split message into sections
    const sections = splitIntoSections(text)

    const allEntries = []
    const sectionResults = []

    for (const sec of sections) {
        // Create a per-section context (inherits lottery/timeslot from message, but rate from section)
        const secCtx = {
            lottery: ctx.lottery,
            timeslot: ctx.timeslot,
            rate: sec.rate || null,
            bet_type: null,
            date_str: null,
        }

        // Pre-scan section: if rate appears only on last line, pre-set it
        const secLines = sec.text.split('\n')
        const secNonEmpty = secLines.map(l => l.trim()).filter(Boolean)
        if (!secCtx.rate && secNonEmpty.length) {
            const lastLine = secNonEmpty[secNonEmpty.length - 1]
            const lastRate = extractRate(lastLine)
            if (lastRate) {
                const lastCleaned = lastLine.replace(/(?:rs|re)[.,\s]*\d+/gi, '').trim()
                const lastNums = lastCleaned.match(/\b\d{2,5}\b/g) || []
                if (lastNums.length === 0) {
                    secCtx.rate = lastRate
                }
            }
        }

        const sectionEntries = []
        for (const rawLine of secLines) {
            const line = rawLine.trim()
            if (!line) continue
            const entries = parseLine(line, secCtx)
            sectionEntries.push(...entries)
        }

        // Mark 12PM ambiguous sections
        let sectionAmbiguous = is12pmAmbiguous
        // Correction messages with no entries or unknown category → AMBIGUOUS
        if (isCorrection && sectionEntries.length === 0) {
            sectionAmbiguous = true
        }

        const mappedEntries = sectionEntries.map(e => ({
            number: e.number,
            betType: e.betType,
            qty: e.qty,
            rate: e.rate,
            category: sectionAmbiguous ? 'AMBIGUOUS' : e.category,
            rawLine: e.rawLine,
            isBox: e.isBox,
        }))

        // Correction messages: reclassify unknown categories as AMBIGUOUS
        if (isCorrection) {
            for (const entry of mappedEntries) {
                if (['UNKNOWN', '3D_FULL', '3D_HALF'].includes(entry.category) && !entry.rate) {
                    entry.category = 'AMBIGUOUS'
                    sectionAmbiguous = true
                }
            }
        }

        allEntries.push(...mappedEntries)
        sectionResults.push({
            text: sec.text,
            rate: sec.rate,
            flag: sec.flag || null,
            entries: mappedEntries,
            isAmbiguous: sectionAmbiguous,
        })

        if (sectionAmbiguous) result.isAmbiguous = true
    }

    result.lottery = ctx.lottery
    result.timeslot = ctx.timeslot
    result.entries = allEntries
    result.sections = sectionResults

    return result
}

// Reset cross-message context (call between batches or request boundaries)
function resetGroupContext() {
    recentByGroup.clear()
}

// ------------------------------------------------------
// EXPORTS
// ------------------------------------------------------

export {
    normalizeSeparators,
    isNoise,
    detectLotteryFromGroup,
    detectLotteryFromText,
    detectTimeslot,
    extractRate,
    extractRateFromLine,
    detectBetType,
    deriveCategory,
    getDefaultRate,
    parseMessage,
    resetGroupContext,
    splitIntoSections,
    shouldSkipGroup,
    inferLotteryFromTimeslot,
    CORRECTION_KW_RE,
}
