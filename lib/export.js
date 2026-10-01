// Exporting lists as CSV / JSON. Display names are typed by other members, so CSV cells that a
// spreadsheet could read as a formula ("=...", "+...", "-...", "@...") are defused.

const FORMULA_START_RE = /^[=+\-@\t\r]/;

function csvCell(value) {
    let text = value == null ? '' : String(value);
    if (FORMULA_START_RE.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns, records) {
    const lines = [columns.join(',')];
    for (const record of records) lines.push(columns.map(column => csvCell(record[column])).join(','));
    return `${lines.join('\r\n')}\r\n`;
}

export function toJson(meta, records) {
    return JSON.stringify({ ...meta, count: records.length, items: records }, null, 2);
}
