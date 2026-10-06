/**
 * 自托管 OFL 字体：按语种组按需加载。
 * - latin：拉丁圆角字体（Nunito / Quicksand / Baloo 2 / Fredoka）
 * - zh：中文字体（思源黑体 / 霞鹜文楷 / 站酷快乐体 / 站酷庆科黄油体 / 得意黑 / 霞鹜新晰黑）
 * - ja：日文圆体（M PLUS Rounded 1c / Zen Maru Gothic）
 *
 * 每个组的 CSS 只加载一次；字体文件本身由浏览器按 @font-face 的 unicode-range 惰性下载。
 */
export type LoadableFontGroup = "latin" | "zh" | "ja";

const loaders: Record<LoadableFontGroup, () => Promise<unknown>> = {
  latin: () => import("./latin"),
  zh: () => import("./zh"),
  ja: () => import("./ja"),
};

const loaded = new Set<LoadableFontGroup>();

export function ensureFontsLoaded(group: LoadableFontGroup): Promise<void> {
  if (loaded.has(group)) return Promise.resolve();
  loaded.add(group);
  return loaders[group]()
    .then(() => undefined)
    .catch(() => {
      loaded.delete(group);
    });
}
