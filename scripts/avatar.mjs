// The repo owner's picture for the report header and the inbox. Orgs and users on github.com and
// gitlab.com get their avatar, downloaded once and kept in ~/.reflektor/cache/avatars/ for good
// (delete that folder to download again). Any other host, or no picture, gets initials on a color.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const HOME = process.env.REFLEKTOR_HOME ?? join(homedir(), ".reflektor");
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 3000;
// White initials read well on each of these, on light and dark pages.
const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#c2410c", "#b45309", "#15803d", "#0f766e", "#0e7490", "#4f46e5", "#a21caf", "#475569"];
// "Some-Entity" -> "SE", "monorepo" -> "M". A GitLab subgroup path uses its top group.
const initialsOf = (owner) => owner
    .split("/")[0]
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "?";
function imageType(bytes) {
    if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("latin1") === "PNG")
        return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return "image/jpeg";
    if (bytes.subarray(0, 3).toString("latin1") === "GIF")
        return "image/gif";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP")
        return "image/webp";
    return null;
}
// null when the host answers that there is no picture. Throws when it cannot answer (offline, a
// server error), so that the next run tries again.
async function get(url, signal) {
    if (!url || new URL(url).protocol !== "https:")
        return null;
    const res = await fetch(url, { signal });
    if (res.status === 404)
        return null;
    if (!res.ok)
        throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
}
async function download(host, owner, signal) {
    let url;
    if (host === "github.com") {
        url = `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
    }
    else {
        // GitLab has no picture URL by name, so ask its public API: a group first, then a user.
        const group = await get(`https://gitlab.com/api/v4/groups/${encodeURIComponent(owner)}?with_projects=false`, signal);
        url = group && (await group.json()).avatar_url;
        if (!url && !owner.includes("/")) {
            const users = await get(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(owner)}`, signal);
            url = users && (await users.json())[0]?.avatar_url;
        }
    }
    const res = await get(url, signal);
    if (!res)
        return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= MAX_BYTES && imageType(bytes) ? bytes : null;
}
export async function ownerAvatar({ host, owner, name }, { allowDownload = true } = {}) {
    const initials = initialsOf(owner ?? name);
    const avatar = { image: null, initials, color: COLORS[initials.charCodeAt(0) % COLORS.length] };
    if (!owner || (host !== "github.com" && host !== "gitlab.com"))
        return avatar;
    // One file per owner. An empty file means the host has no picture for it.
    const file = join(HOME, "cache", "avatars", host, owner.toLowerCase().replace(/[^a-z0-9-]+/g, "_"));
    let bytes = existsSync(file) ? readFileSync(file) : null;
    if (!bytes && allowDownload) {
        try {
            bytes = (await download(host, owner, AbortSignal.timeout(TIMEOUT_MS))) ?? Buffer.alloc(0);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, bytes);
        }
        catch {
            // Offline, or the host had a problem: initials this time.
        }
    }
    const type = bytes?.length ? imageType(bytes) : null;
    if (type)
        avatar.image = `data:${type};base64,${bytes.toString("base64")}`;
    return avatar;
}
