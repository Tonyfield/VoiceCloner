/** 中文字体（OFL，@fontsource 自托管 + 无 CSS 的字体包注入 @font-face）。 */
import "@fontsource/noto-sans-sc/chinese-simplified-400.css";
import "@fontsource/noto-sans-sc/latin-400.css";
import "@fontsource/zcool-kuaile";
import "@fontsource/zcool-qingke-huangyou";
import "@fontsource/lxgw-wenkai";
import { injectPackagedFontFaces } from "./packaged";

injectPackagedFontFaces();
