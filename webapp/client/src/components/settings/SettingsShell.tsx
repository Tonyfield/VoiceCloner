import { type ReactNode, useCallback, useRef, useState } from "react";
import "./settings.css";

export interface SettingsTab {
  key: string;
  label: string;
}

interface Props {
  tabs: SettingsTab[];
  active: string;
  onChange: (key: string) => void;
  /** 每个页签的面板内容；所有面板都会渲染（保留滚动位置与表单注册）。 */
  children: (key: string) => ReactNode;
}

/** 切换动画：先淡出 0.5s，再淡入 0.5s。 */
const FADE_MS = 500;

/**
 * Tab 多面板设置区：左侧竖向 Tab 栏（200px，固定）+ 右侧参数设置面板。
 * 切换页签时右侧面板先淡出、再淡入；面板各自滚动并记住滚动位置。
 * 窄于 900px 时 Tab 栏转为顶部横向滚动条。
 */
export default function SettingsShell({ tabs, active, onChange, children }: Props) {
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollTops = useRef<Record<string, number>>({});
  const switching = useRef(false);
  const [fading, setFading] = useState(false);

  const selectTab = useCallback(
    (key: string) => {
      if (key === active || switching.current) return;
      const current = panelRefs.current[active];
      if (current) scrollTops.current[active] = current.scrollTop;

      switching.current = true;
      setFading(true); // 1) 当前面板淡出
      window.setTimeout(() => {
        onChange(key); // 2) 切换（新面板此时透明度为 0）
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setFading(false); // 3) 新面板淡入
            const next = panelRefs.current[key];
            if (next) next.scrollTop = scrollTops.current[key] ?? 0;
            window.setTimeout(() => {
              switching.current = false;
            }, FADE_MS);
          });
        });
      }, FADE_MS);
    },
    [active, onChange]
  );

  return (
    <div className="st-shell">
      <nav className="st-rail" role="tablist" aria-orientation="vertical">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className="st-rail-item"
            aria-selected={tab.key === active}
            onClick={() => selectTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="st-main">
        <div className="st-panels">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className="st-panel"
              data-active={tab.key === active}
              role="tabpanel"
              aria-hidden={tab.key !== active}
              style={{ opacity: tab.key === active && !fading ? 1 : 0 }}
              ref={(el) => {
                panelRefs.current[tab.key] = el;
              }}
            >
              <div className="st-panel-inner">{children(tab.key)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
