import { call } from "./api";

// One meal per request keeps the free cloud's short invocation limit bounded.
export async function exportPersonal(
  options: {
    cancelled?: () => boolean;
    progress?: (message: string) => void;
  } = {},
) {
  const check = () => {
    if (options.cancelled?.()) throw Error("导出已停止，请重新导出完整记录");
  };
  check();
  const profile = await call("export.mine", { section: "profile" });
  check();
  const result = { ...profile, kitchens: [] as any[] };
  let characters = JSON.stringify(result).length,
    count = 0;
  for (const kitchen of profile.kitchens) {
    const entry = {
      name: kitchen.name,
      role: kitchen.role,
      meals: [] as any[],
    };
    let cursor = "";
    const cursors = new Set<string>();
    do {
      check();
      const page = await call("export.mine", {
        section: "meals",
        kitchen_id: kitchen.id,
        cursor,
      });
      check();
      characters += JSON.stringify(page.items).length;
      if (characters > 2 * 1024 * 1024)
        throw Error("JSON记录较大，请使用可分卷的完整厨房备份");
      entry.meals.push(...page.items);
      count += page.items.length;
      options.progress?.("已读取 " + count + " 场饭局，正在分批导出");
      cursor = page.next_cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw Error("导出位置异常，请重新导出");
        cursors.add(cursor);
      }
    } while (cursor);
    result.kitchens.push(entry);
  }
  check();
  return result;
}
