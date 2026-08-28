/**
 * Media.
 *
 * The whole reason a desktop app beats a browser for this work: a client's
 * 3 GB master is already on this disk. TikTok and Vimeo take the bytes
 * directly from here, and only the networks that insist on fetching a URL
 * themselves (Instagram, and Reddit's link posts) need it hosted first.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { dialog } = require("electron");

const TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  webm: "video/webm", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", pdf: "application/pdf",
};

function describe(filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return {
    id: "med_" + crypto.createHash("sha1").update(filePath + stat.mtimeMs).digest("hex").slice(0, 12),
    path: filePath,
    name: path.basename(filePath),
    ext,
    type: TYPES[ext] || "application/octet-stream",
    size: stat.size,
    kind: (TYPES[ext] || "").startsWith("video") ? "video" : (TYPES[ext] || "").startsWith("image") ? "image" : "file",
  };
}

async function pick(window) {
  const res = await dialog.showOpenDialog(window, {
    title: "Choose media",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images and video", extensions: ["jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "m4v", "webm"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled) return [];
  return res.filePaths.map(describe);
}

/** Read a media reference for a direct upload. */
function read(ref) {
  if (ref && ref.url && !ref.path) return { name: ref.name, type: ref.type, size: ref.size, url: ref.url, bytes: null };
  const p = typeof ref === "string" ? ref : ref.path;
  if (!p || !fs.existsSync(p)) {
    const e = new Error(`The file for this post is missing: ${p || "(no path)"}`);
    e.code = "MEDIA_MISSING";
    throw e;
  }
  const info = describe(p);
  return { ...info, bytes: fs.readFileSync(p) };
}

/** A small preview for the composer, kept well under a megabyte. */
function thumbnail(ref) {
  try {
    const info = describe(typeof ref === "string" ? ref : ref.path);
    if (info.kind !== "image" || info.size > 4 * 1024 * 1024) return null;
    return `data:${info.type};base64,${fs.readFileSync(info.path).toString("base64")}`;
  } catch (e) {
    return null;
  }
}

function exists(ref) {
  try { return fs.existsSync(typeof ref === "string" ? ref : ref.path); } catch (e) { return false; }
}

module.exports = { pick, read, describe, thumbnail, exists, TYPES };
