// Review time: the must-read words at 200 a minute, plus a minute to get oriented, plus a minute per flow.
const WORDS_PER_MINUTE = 200;
const countWords = (text) => text?.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
const changedText = (file) => {
    const pick = (content, lines) => {
        if (!content || !lines.length)
            return "";
        const all = content.split("\n");
        return lines.map((n) => all[n - 1] ?? "").join("\n");
    };
    return `${pick(file.newContent, file.changedLines.added)}\n${pick(file.oldContent, file.changedLines.removed)}`;
};
export const reviewMinutes = (report, files) => {
    const byPath = new Map(files.map((f) => [f.path, f]));
    let words = 0;
    for (const section of report.sections) {
        if (section.review !== "must")
            continue;
        words += countWords(section.reason);
        for (const h of section.highlights)
            words += countWords(h.text);
        for (const sf of section.files) {
            words += countWords(sf.note);
            for (const n of sf.lineNotes ?? [])
                words += countWords(n.text);
            const file = byPath.get(sf.path);
            if (file && !file.binary && !file.tooLarge)
                words += countWords(changedText(file));
        }
    }
    return Math.ceil(words / WORDS_PER_MINUTE) + 1 + report.flows.length;
};
