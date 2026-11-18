// Resolve ffmpeg/ffprobe full paths (winget install may post-date this shell's PATH).
import fs from "node:fs";
import { execSync } from "node:child_process";

const KNOWN_WINGET_BIN = "C:\\Users\\micro\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin";

function find(name) {
  try {
    const out = execSync(`where ${name}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\r\n")[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  const known = `${KNOWN_WINGET_BIN}\\${name}.exe`;
  if (fs.existsSync(known)) return known;
  return name;
}

export const FFMPEG = process.env.FFMPEG_PATH || find("ffmpeg");
export const FFPROBE = process.env.FFPROBE_PATH || find("ffprobe");
