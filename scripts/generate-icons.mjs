import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("../cloudfunctions/api/node_modules/sharp");
const icons = {
  menu: '<rect x="7" y="7" width="12" height="12" rx="3"/><rect x="29" y="7" width="12" height="12" rx="3"/><rect x="7" y="29" width="12" height="12" rx="3"/><rect x="29" y="29" width="12" height="12" rx="3"/>',
  meal: '<path d="M7 25h34c-1 10-7 16-17 16S8 35 7 25Z"/><path d="M12 44h24M16 7c-4 5 4 6 0 11M25 5c-4 5 4 6 0 11M34 7c-4 5 4 6 0 11"/>',
  me: '<circle cx="24" cy="15" r="9"/><path d="M8 43c0-10 6-16 16-16s16 6 16 16"/>',
};
fs.mkdirSync("src/assets/icons", { recursive: true });
for (const [name, body] of Object.entries(icons))
  for (const selected of [false, true]) {
    const color = selected ? "#244b3b" : "#657168";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 64 64"><g transform="translate(8 8)" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
    await sharp(Buffer.from(svg))
      .resize(81, 81)
      .png()
      .toFile(`src/assets/icons/${name}${selected ? "-active" : ""}.png`);
  }
