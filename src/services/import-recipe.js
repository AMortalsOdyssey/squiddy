"use strict";
// Parses text supplied by its user. It never fetches a URL or executes pasted content.
function parseRecipeText(value) {
  const raw = String(value || "")
    .slice(0, 6000)
    .replace(/\r/g, "");
  const links = raw.match(/https:\/\/[^\s<>]+/g) || [];
  const source_url = (links[0] || "").replace(/[，。；）)]+$/g, "");
  const lines = raw
    .replace(/https:\/\/[^\s<>]+/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const title = (
    lines.find(
      (s) => !/^(食材|材料|用料|做法|步骤|分享|复制|打开|#)/.test(s),
    ) || ""
  )
    .replace(/^【|】$/g, "")
    .slice(0, 40);
  let mode = "",
    ingredients = [],
    steps = [];
  for (const line of lines) {
    if (/^(食材|材料|用料)[:：]?/.test(line)) {
      mode = "ingredients";
      const rest = line.replace(/^(食材|材料|用料)[:：]?/, "").trim();
      if (rest) ingredients.push(...rest.split(/[、,，;；]/));
      continue;
    }
    if (/^(做法|步骤)[:：]?/.test(line)) {
      mode = "steps";
      const rest = line.replace(/^(做法|步骤)[:：]?/, "").trim();
      if (rest) steps.push(rest);
      continue;
    }
    if (line === title) continue;
    if (mode === "ingredients") ingredients.push(...line.split(/[、,，;；]/));
    if (mode === "steps") steps.push(line);
  }
  return {
    name: title,
    source_url,
    ingredients: ingredients
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30)
      .join("、"),
    steps: steps.join("\n").slice(0, 1200),
  };
}
module.exports = { parseRecipeText };
