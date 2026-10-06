import type { CSSProperties, ReactNode } from "react";
import { Card } from "antd";

/**
 * 设置卡片：标题下方可带一行小标题（说明）。
 * 小标题放在卡片标题下方、标题与内容之间的分隔线之上，保证「标题 → 小标题 → 分隔线 → 内容」。
 */
export default function SettingsCard({
  title,
  subtitle,
  extra,
  children,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const headerTitle = subtitle ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span>{title}</span>
      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--vc-muted, rgba(0,0,0,0.55))" }}>
        {subtitle}
      </span>
    </div>
  ) : (
    title
  );

  return (
    <Card className="flat-card" title={headerTitle} extra={extra} style={{ borderRadius: 16, ...style }}>
      {children}
    </Card>
  );
}
