import { Button, Slider, Space, theme, Tooltip, Typography } from "antd";
import {
  CaretRightOutlined,
  CloseOutlined,
  PauseOutlined,
  RetweetOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from "@ant-design/icons";
import { useI18n } from "../i18n";

/** 秒 → mm:ss（非法/负值按 0 处理）。 */
function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * 底部连播控制条（纯展示）：播放/暂停、上一段/下一段、进度、连播开关、关闭。
 * 播放逻辑全部由父级 TaskDetail 通过回调驱动。
 */
export default function PlaybackBar({
  visible,
  label,
  isPlaying,
  continuous,
  current,
  duration,
  hasPrev,
  hasNext,
  onTogglePlay,
  onPrev,
  onNext,
  onStop,
  onToggleContinuous,
  onSeek,
}: {
  visible: boolean;
  label: string;
  isPlaying: boolean;
  continuous: boolean;
  current: number;
  duration: number;
  hasPrev: boolean;
  hasNext: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onStop: () => void;
  onToggleContinuous: () => void;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useI18n();
  const { token } = theme.useToken();
  if (!visible) return null;

  return (
    <div
      style={{
        flex: "0 0 auto",
        marginTop: 8,
        padding: "8px 12px",
        borderRadius: 12,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        boxShadow: token.boxShadowTertiary,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Space size={4}>
          <Tooltip title={isPlaying ? t("detail.ttsPauseShort") : t("seg.play")}>
            <Button
              shape="circle"
              type="primary"
              aria-label={isPlaying ? t("detail.ttsPauseShort") : t("seg.play")}
              icon={isPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
              onClick={onTogglePlay}
            />
          </Tooltip>
          <Tooltip title={t("detail.prevSegment")}>
            <Button
              shape="circle"
              aria-label={t("detail.prevSegment")}
              icon={<StepBackwardOutlined />}
              disabled={!hasPrev}
              onClick={onPrev}
            />
          </Tooltip>
          <Tooltip title={t("detail.nextSegment")}>
            <Button
              shape="circle"
              aria-label={t("detail.nextSegment")}
              icon={<StepForwardOutlined />}
              disabled={!hasNext}
              onClick={onNext}
            />
          </Tooltip>
        </Space>

        <div style={{ flex: "1 1 200px", minWidth: 160 }}>
          <Slider
            min={0}
            max={duration || 0}
            value={Math.min(current, duration || 0)}
            disabled={!duration}
            tooltip={{ formatter: (value) => formatTime(Number(value) || 0) }}
            onChange={(value) => onSeek(Number(value))}
          />
        </div>

        <Typography.Text
          type="secondary"
          style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, flex: "0 0 auto" }}
        >
          {formatTime(current)}/{formatTime(duration)}
        </Typography.Text>

        <Button
          size="small"
          type={continuous ? "primary" : "default"}
          icon={<RetweetOutlined />}
          onClick={onToggleContinuous}
        >
          {t("detail.continuousPlay")}
        </Button>

        <Tooltip title={t("detail.stopPlayback")}>
          <Button
            size="small"
            aria-label={t("detail.stopPlayback")}
            icon={<CloseOutlined />}
            onClick={onStop}
          />
        </Tooltip>
      </div>

      <Typography.Text
        type="secondary"
        style={{ display: "block", marginTop: 4, fontSize: 12 }}
        ellipsis={{ tooltip: label }}
      >
        {label}
      </Typography.Text>
    </div>
  );
}
