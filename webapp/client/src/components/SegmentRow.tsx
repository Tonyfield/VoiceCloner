import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Checkbox, Input, Modal, Popover, Space, Tag, Tooltip, Typography, message, theme } from "antd";
import { CheckOutlined, CloseOutlined, DeleteOutlined, DislikeOutlined, HistoryOutlined, LikeOutlined, ReloadOutlined, SoundOutlined } from "@ant-design/icons";
import {
  autoPhonetic,
  getSegmentSteps,
  segmentText,
  synthesizeSegment,
  taskFileUrl,
  updateSegment,
  type MarkInfo,
  type Segment,
  type SegmentMark,
  type SegmentStep,
} from "../api/client";
import { addMark, marksToXml, parseMarks, renderSegments, validatePinyin } from "../lib/phoneticMarks";
import { getErrorMessage } from "../lib/errors";
import { textOnColor } from "../themes";
import { useI18n } from "../i18n";

const { TextArea } = Input;

const ED_STYLE: CSSProperties = {
  fontSize: 13,
  lineHeight: "22px",
  padding: "4px 11px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/** 编辑框最多显示 8 行（22px/行 + 上下 padding 8px + 上下边框 2px），超出由外层容器滚动。 */
const EDITOR_MAX_HEIGHT = 8 * 22 + 8 + 2;

interface Selection {
  start: number;
  end: number;
  selText: string;
}

/** 注音浮层状态：新增（基于选中文字，带选区起点）或编辑（基于已有高亮 mark）。 */
type AnnotateState =
  | { mode: "new"; selText: string; start: number }
  | { mode: "edit"; markIndex: number };

/** 单个分段：原文编辑器或持久化注音 XML + 底部操作行，交错底色由 index 决定。 */
export default function SegmentRow({
  taskId,
  seg,
  index,
  selected,
  onToggle,
  onDraft,
  onSaved,
  draft,
  audioRefreshToken,
  serverRefreshToken,
  onPlay,
  playing,
  mark,
  onMarked,
}: {
  taskId: number;
  seg: Segment;
  index: number;
  selected: boolean;
  onToggle: (key: string) => void;
  /** 记录未保存的编辑，供虚拟列表卸载后重新挂载时恢复；dirty=false 表示清除。 */
  onDraft: (key: string, text: string, phonetic: string, dirty: boolean) => void;
  /** 本段编辑已保存到服务端后回调（用于刷新章节数据）。 */
  onSaved: (source: string) => void | Promise<void>;
  draft?: { text: string; phonetic: string };
  audioRefreshToken: number;
  serverRefreshToken: number;
  onPlay: (key: string, url: string, source: string) => void;
  playing: boolean;
  /** 当前标记（点赞/点踩）与反馈 */
  mark?: MarkInfo;
  onMarked: (key: string, mark: SegmentMark | null, feedback: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { token } = theme.useToken();
  // 注音高亮块的文字色：灰底（colorPrimaryBg）上取对比色，黑白灰主题下为中灰底 + 白字。
  const onPrimaryBg = textOnColor(token.colorPrimaryBg);
  const initial = draft ?? { text: seg.text, phonetic: seg.phonetic };
  const [text, setText] = useState(initial.text);
  const [phonetic, setPhonetic] = useState(initial.phonetic);
  const [audioVersion, setAudioVersion] = useState(0);
  const [audioName, setAudioName] = useState<string | null>(seg.audio);
  const [synth, setSynth] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"text" | "segment" | "code">("text");
  const [words, setWords] = useState<string[] | null>(null);
  const [wordsLoading, setWordsLoading] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [annotate, setAnnotate] = useState<AnnotateState | null>(null);
  const [pyInput, setPyInput] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);
  const orig = useRef({ text: seg.text, phonetic: seg.phonetic });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [savingMark, setSavingMark] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [steps, setSteps] = useState<SegmentStep[] | null>(null);
  /** 悬浮在已注音文字上时的气泡：标记序号 + 相对编辑区的定位（px）。 */
  const [hover, setHover] = useState<{ markIndex: number; top: number; left: number } | null>(null);
  const editorBoxRef = useRef<HTMLDivElement | null>(null);
  const hoverHideRef = useRef<number | null>(null);

  /** 取消「离开后延迟隐藏悬浮气泡」的定时器（鼠标移入气泡时不隐藏）。 */
  const cancelHoverHide = () => {
    if (hoverHideRef.current !== null) {
      window.clearTimeout(hoverHideRef.current);
      hoverHideRef.current = null;
    }
  };
  /** 鼠标离开注音文字/气泡后延迟隐藏，留出移动到气泡上的时间。 */
  const scheduleHoverHide = () => {
    cancelHoverHide();
    hoverHideRef.current = window.setTimeout(() => {
      hoverHideRef.current = null;
      setHover(null);
    }, 160);
  };
  /** 鼠标进入某个注音文字：记录其相对编辑区的位置，用于定位气泡。 */
  const showHover = (markIndex: number, el: HTMLElement) => {
    const box = editorBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    const rect = el.getBoundingClientRect();
    cancelHoverHide();
    setHover({ markIndex, top: rect.top - box.top, left: rect.left - box.left });
  };

  const dirty = text !== orig.current.text || phonetic !== orig.current.phonetic;
  const audioUrl = audioName ? `${taskFileUrl(taskId, audioName)}?t=${audioVersion}` : null;
  const marks = useMemo(() => parseMarks(phonetic), [phonetic]);
  const segs = useMemo(() => renderSegments(text, marks), [text, marks]);
  // 已注音片段在原文中的字符区间（用于按光标位置判定点击了哪个注音）。
  const markedRanges = useMemo(() => {
    let offset = 0;
    const ranges: Array<{ start: number; end: number; markIndex: number }> = [];
    for (const seg of segs) {
      const start = offset;
      offset += seg.text.length;
      if (seg.marked) ranges.push({ start, end: offset, markIndex: seg.markIndex });
    }
    return ranges;
  }, [segs]);

  const syncSelection = (ta: HTMLTextAreaElement) => {
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    if (e > s) {
      const raw = ta.value.slice(s, e);
      const lead = raw.length - raw.trimStart().length;
      const selText = raw.trim();
      // start 需对齐到 trim 后的文字起点，否则含空白选区会令 addMark 的定位失效。
      if (selText) { setSelection({ start: s + lead, end: s + lead + selText.length, selText }); return; }
    }
    setSelection(null);
  };

  const confirmAnnotate = () => {
    if (!annotate) return;
    // 编辑已有注音时，清空拼音点击“保存”等同于删除该注音
    if (annotate.mode === "edit" && !pyInput.trim()) {
      removeMark();
      return;
    }
    const err = validatePinyin(pyInput);
    if (err) {
      message.warning(
        err.code === "invalidSyllable"
          ? t("error.invalidSyllable", { token: err.token })
          : t("error.invalidPinyin", { token: err.token })
      );
      return;
    }
    if (annotate.mode === "edit") {
      const next = [...marks];
      next[annotate.markIndex] = { ...next[annotate.markIndex], pinyin: pyInput.trim() };
      setPhonetic(marksToXml(next, text));
    } else {
      setPhonetic(marksToXml(addMark(marks, annotate.selText, pyInput, text, annotate.start), text));
    }
    setAnnotate(null);
    setSelection(null);
    setPyInput("");
    setHover(null);
  };
  const removeMark = () => {
    if (!annotate || annotate.mode !== "edit") return;
    setPhonetic(marksToXml(marks.filter((_, i) => i !== annotate.markIndex), text));
    setAnnotate(null);
    setSelection(null);
    setPyInput("");
    setHover(null);
  };
  /** 取消注音编辑（气泡里的叉号）：不改动文本，直接关闭编辑框。 */
  const cancelAnnotate = () => {
    setAnnotate(null);
    setSelection(null);
    setPyInput("");
    setHover(null);
  };

  // 浮层外点击 → 关闭菜单 / 注音编辑框（失去焦点自动关闭）
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const pop = popRef.current;
      if (pop && !pop.contains(e.target as Node)) {
        setSelection(null);
        setAnnotate(null);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  // 组件卸载时清理悬浮气泡的延迟隐藏定时器。
  useEffect(() => () => {
    if (hoverHideRef.current !== null) window.clearTimeout(hoverHideRef.current);
  }, []);

  // 未保存的编辑写入父级草稿（父级以草稿为准保存），虚拟列表卸载本行后
  // 重新挂载时可据此恢复，避免虚拟滚动丢掉未保存修改。
  useEffect(() => {
    onDraft(seg.key, text, phonetic, dirty);
  }, [dirty, onDraft, phonetic, seg.key, text]);

  // 「分词文本」视图：按当前（可能已编辑的）原文向服务端取 jieba 分词结果。
  useEffect(() => {
    if (viewMode !== "segment") return;
    let cancelled = false;
    setWordsLoading(true);
    segmentText(taskId, seg.key, text)
      .then((res) => { if (!cancelled) setWords(res.words); })
      .catch((error) => {
        if (!cancelled) {
          setWords(null);
          message.error(t("seg.wordsFailed", { error: getErrorMessage(error, t("error.request")) }));
        }
      })
      .finally(() => { if (!cancelled) setWordsLoading(false); });
    return () => { cancelled = true; };
  }, [seg.key, taskId, text, viewMode]);

  useEffect(() => {
    setAudioName(seg.audio);
    if (seg.audio) {
      setAudioVersion((value) => value + 1);
    }
  }, [audioRefreshToken, seg.audio]);

  useEffect(() => {
    if (!serverRefreshToken) return;
    setText(seg.text);
    setPhonetic(seg.phonetic);
    orig.current = { text: seg.text, phonetic: seg.phonetic };
    onDraft(seg.key, seg.text, seg.phonetic, false);
    setSelection(null);
    setAnnotate(null);
    setPyInput("");
  }, [onDraft, seg.key, seg.phonetic, seg.text, serverRefreshToken]);

  const regen = async () => {
    setSynth(true);
    try {
      // 先保存当前编辑，否则服务端中间文件仍是旧文本/注音，合成会送出未注音的 input。
      if (dirty) {
        await updateSegment(taskId, seg.key, { text, phonetic });
        orig.current = { text, phonetic };
        onDraft(seg.key, text, phonetic, false);
        await onSaved(seg.source);
      }
      await synthesizeSegment(taskId, seg.key);
      // 音频文件名带内容 hash，重新加载该章节以获取服务端返回的最新文件名。
      await onSaved(seg.source);
      setAudioVersion((v) => v + 1);
      message.success(t("seg.regenerated", { key: seg.key }));
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    } finally { setSynth(false); }
  };

  const runAutoPhonetic = async () => {
    setAutoLoading(true);
    try {
      const result = await autoPhonetic(taskId, seg.key, text);
      // 注音会先做 IndexTTS 文字增强（感叹词前缀/分词间隔），文本可能被改写
      setText(result.text);
      setPhonetic(result.phonetic);
      message.success(t("seg.annotated", { key: seg.key }));
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    } finally {
      setAutoLoading(false);
    }
  };

  const editExisting = (markIndex: number) => {
    cancelHoverHide();
    setHover(null);
    setAnnotate({ mode: "edit", markIndex });
    setPyInput(marks[markIndex]?.pinyin ?? "");
    setSelection(null);
  };

  // 已注音文字由高亮层上的 span 直接接收鼠标事件（悬浮气泡/点击编辑）；
  // 这里保留按光标位置判定的兜底逻辑，处理高亮层未覆盖到的情况。
  const handleCaret = (ta: HTMLTextAreaElement) => {
    syncSelection(ta);
    const start = ta.selectionStart ?? 0;
    if ((ta.selectionEnd ?? 0) !== start) return;
    const range = markedRanges.find((item) => start >= item.start && start < item.end);
    if (range) editExisting(range.markIndex);
  };

  /** 点赞：再次点击取消。 */
  const toggleLike = async () => {
    setSavingMark(true);
    try {
      await onMarked(seg.key, mark?.mark === "like" ? null : "like", "");
    } finally {
      setSavingMark(false);
    }
  };

  const openFeedback = () => {
    setFeedbackText(mark?.mark === "dislike" ? mark.feedback : "");
    setFeedbackOpen(true);
  };

  /** 提交点踩（反馈可为空）。 */
  const submitFeedback = async () => {
    setSavingMark(true);
    try {
      await onMarked(seg.key, "dislike", feedbackText);
      setFeedbackOpen(false);
    } finally {
      setSavingMark(false);
    }
  };

  const loadSteps = async () => {
    setStepsOpen(true);
    try {
      setSteps(await getSegmentSteps(taskId, seg.key));
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    }
  };

  const STEP_LABEL: Record<SegmentStep["step"], string> = {
    segment: t("step.segment"),
    phonetic: t("step.phonetic"),
    synthesize: t("step.synthesize"),
  };

  const renderStep = (step: SegmentStep) => {
    const d = step.detail ?? {};
    let summary: string;
    if (step.step === "segment") {
      summary = t("step.length", { count: String(d.length ?? "?") });
    } else if (step.step === "phonetic") {
      summary = t("step.phoneticSummary", {
        operation: String(d.operation ?? ""),
        input: String(d.input ?? ""),
        output: String(d.output ?? ""),
      });
    } else {
      summary = t("step.synthSummary", {
        input: String(d.input ?? ""),
        status: String(step.status ?? "-"),
        duration: String(step.duration_ms ?? "-"),
      });
    }
    return (
      <div
        key={step.id}
        style={{ padding: "6px 0", borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {step.created_at} · {STEP_LABEL[step.step]}
        </Typography.Text>
        <div style={{ fontSize: 12, wordBreak: "break-word" }}>{summary}</div>
        {step.error && (
          <div style={{ fontSize: 12, color: token.colorError }}>{t("step.error", { error: step.error ?? "" })}</div>
        )}
      </div>
    );
  };

  // 选中文字 → 注音气泡菜单
  const menuBar = (
    <div style={{ width: 320 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("seg.selectedCount", { count: selection?.selText.length ?? 0 })}<b>{selection?.selText}</b>
      </Typography.Text>
      <Space style={{ marginTop: 8, width: "100%" }}>
        <Button size="small" type="primary" onClick={() => {
          if (!selection) return;
          setAnnotate({ mode: "new", selText: selection.selText, start: selection.start });
          setPyInput("");
          setSelection(null);
        }}>{t("seg.annotate")}</Button>
      </Space>
    </div>
  );

  // 注音编辑框（新增 / 编辑已有高亮 共用同一浮层）
  const annotateBar = (
    <div style={{ width: 480 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {annotate?.mode === "edit"
          ? <>{t("seg.fragment")}<b>{marks[annotate.markIndex]?.text}</b></>
          : annotate && annotate.mode === "new"
            ? <>{t("seg.selectedCount", { count: annotate.selText.length })}<b>{annotate.selText}</b></>
            : null}
      </Typography.Text>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <Input
          size="small"
          placeholder={t("seg.pinyinPlaceholder")}
          value={pyInput}
          onChange={(e) => setPyInput(e.target.value)}
          onPressEnter={confirmAnnotate}
          autoFocus
          style={{ flex: 1 }}
        />
        {annotate?.mode === "edit" && (
          <Tooltip title={t("act.delete")}>
            <Button danger size="small" icon={<DeleteOutlined />} aria-label={t("act.delete")} onClick={removeMark} />
          </Tooltip>
        )}
        <Tooltip title={t("act.cancel")}>
          <Button size="small" icon={<CloseOutlined />} aria-label={t("act.cancel")} onClick={cancelAnnotate} />
        </Tooltip>
        <Tooltip title={annotate?.mode === "edit" ? t("act.save") : t("seg.annotate")}>
          <Button
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            aria-label={annotate?.mode === "edit" ? t("act.save") : t("seg.annotate")}
            onClick={confirmAnnotate}
          />
        </Tooltip>
      </div>
    </div>
  );

  return (
    <div
      className="segment-row"
      style={{
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        padding: "8px 10px",
        margin: "2px 0",
        background: playing || index % 2 === 1 ? token.colorFillQuaternary : "transparent",
        // 播放中：左侧强调条（不改字色，规避黑白灰主题下灰底深字对比问题）。
        boxShadow: playing ? `inset 3px 0 0 ${token.colorPrimary}` : undefined,
      }}
    >
      <div className="segment-header">
        <Space align="start">
          <Checkbox checked={selected} onChange={() => onToggle(seg.key)} style={{ paddingTop: 2 }} />
          <Tag style={{ marginTop: 2 }}>{seg.key}</Tag>
        </Space>
        <div className="segment-view-tabs" role="tablist" aria-label={t("seg.viewAria", { key: seg.key })}>
          {([
            ["text", t("seg.viewText")],
            ["segment", t("seg.viewSegment")],
            ["code", t("seg.viewCode")],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={viewMode === key}
              className={viewMode === key ? "segment-view-tab active" : "segment-view-tab"}
              onClick={() => setViewMode(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {viewMode === "text" ? (
        <div ref={editorBoxRef} style={{ position: "relative" }}>
          {/* 单个滚动容器：高亮层与文本域同宽、随容器一起滚动，保证换行与选区完全对齐 */}
          <div style={{ position: "relative", maxHeight: EDITOR_MAX_HEIGHT, overflowY: "auto" }}>
            <div
              aria-hidden
              style={{
                ...ED_STYLE,
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                // 置于文本域之上：注音块用不透明灰底盖住文本域的深色文字，并绘制对比色文字
                zIndex: 2,
                pointerEvents: "none",
                border: "1px solid transparent",
                color: "transparent",
              }}
            >
              {segs.map((s, i) =>
                s.marked ? (
                  <span
                    key={i}
                    data-phoneme={s.markIndex}
                    onMouseEnter={(e) => showHover(s.markIndex, e.currentTarget)}
                    onMouseLeave={scheduleHoverHide}
                    onClick={() => editExisting(s.markIndex)}
                    style={{
                      background: token.colorPrimaryBg,
                      color: onPrimaryBg,
                      borderBottom: `2px solid ${token.colorPrimaryBorder}`,
                      borderRadius: 3,
                      // 只有已注音文字接收鼠标事件（其余高亮层穿透到文本域），
                      // 以便悬浮显示注音气泡、点击进入编辑。
                      pointerEvents: "auto",
                      cursor: "pointer",
                    }}
                  >
                    {s.text}
                  </span>
                ) : (
                  <span key={i}>{s.text}</span>
                )
              )}
              {segs.length === 0 && <span>{text}</span>}
            </div>

            <TextArea
              value={text}
              onChange={(e) => {
                const nextText = e.target.value;
                setHover(null);
                setText(nextText);
                setPhonetic((current) => marksToXml(parseMarks(current), nextText));
              }}
              onMouseUp={(e) => handleCaret(e.currentTarget)}
              onKeyUp={(e) => syncSelection(e.currentTarget as HTMLTextAreaElement)}
              autoSize={{ minRows: 1 }}
              style={{
                ...ED_STYLE,
                position: "relative",
                zIndex: 1,
                color: token.colorText,
                caretColor: token.colorText,
                background: "transparent",
              }}
            />
          </div>

          {(selection || annotate) && (
            <div
              ref={popRef}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                right: 0,
                marginBottom: 6,
                zIndex: 20,
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadiusLG,
                padding: 10,
                boxShadow: token.boxShadowTertiary,
              }}
            >
              {annotate ? annotateBar : menuBar}
            </div>
          )}

          {/* 悬浮在已注音文字上的注音气泡：显示拼音，点击进入编辑 */}
          {hover && !annotate && !selection && marks[hover.markIndex] && (
            <div
              onMouseEnter={cancelHoverHide}
              onMouseLeave={scheduleHoverHide}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => editExisting(hover.markIndex)}
              style={{
                position: "absolute",
                top: hover.top,
                left: hover.left,
                transform: "translateY(calc(-100% - 6px))",
                zIndex: 30,
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadiusLG,
                padding: "4px 8px",
                boxShadow: token.boxShadowTertiary,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Typography.Text style={{ fontSize: 12 }}>
                {t("seg.pinyinTooltip", { pinyin: marks[hover.markIndex].pinyin })}
              </Typography.Text>
            </div>
          )}
        </div>
      ) : viewMode === "segment" ? (
        <pre className="segment-source-code">
          {wordsLoading ? t("seg.wordsLoading") : (words && words.length ? words.join(" | ") : text).replace(/[\r\n]+$/, "")}
        </pre>
      ) : (
        <pre className="segment-source-code">{phonetic.replace(/[\r\n]+$/, "")}</pre>
      )}

      <div className="segment-actions" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
        <Space wrap>
          <Button size="small" onClick={() => void runAutoPhonetic()} loading={autoLoading}>
            {t("seg.autoPhonetic")}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void regen()} loading={synth}>
            {t("seg.regenerate")}
          </Button>
        </Space>
        {audioName ? (
          <Button
            size="small"
            icon={<SoundOutlined />}
            type={playing ? "primary" : "default"}
            onClick={() => onPlay(seg.key, audioUrl ?? audioName, seg.source)}
          >
            {playing ? t("seg.playing") : t("seg.play")}
          </Button>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t("seg.noAudio")}</Typography.Text>
        )}

        {/* 标记：点赞 / 点踩（点踩弹反馈框，反馈可为空）；步骤记录查看 */}
        <Space size={4}>
          <Tooltip title={mark?.mark === "like" ? t("seg.unlike") : t("seg.like")}>
            <Button
              size="small"
              loading={savingMark}
              type={mark?.mark === "like" ? "primary" : "default"}
              icon={<LikeOutlined />}
              onClick={() => void toggleLike()}
            />
          </Tooltip>
          <Tooltip title={t("seg.dislikeTooltip")}>
            <Button
              size="small"
              danger={mark?.mark === "dislike"}
              type={mark?.mark === "dislike" ? "primary" : "default"}
              icon={<DislikeOutlined />}
              onClick={openFeedback}
            />
          </Tooltip>
          <Popover
            open={stepsOpen}
            onOpenChange={(open) => (open ? void loadSteps() : setStepsOpen(false))}
            trigger="click"
            title={t("seg.stepsTitle", { key: seg.key })}
            content={
              <div style={{ maxHeight: 320, width: 460, overflow: "auto" }}>
                {steps === null ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t("seg.loading")}</Typography.Text>
                ) : steps.length ? (
                  steps.map(renderStep)
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t("seg.noRecords")}</Typography.Text>
                )}
              </div>
            }
          >
            <Tooltip title={t("seg.stepsTooltip")}>
              <Button size="small" icon={<HistoryOutlined />} />
            </Tooltip>
          </Popover>
        </Space>
        {mark?.feedback ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("seg.feedback", { text: mark.feedback })}
          </Typography.Text>
        ) : null}
      </div>

      <Modal
        open={feedbackOpen}
        title={t("seg.feedbackTitle", { key: seg.key })}
        okText={t("act.submit")}
        cancelText={t("act.cancel")}
        confirmLoading={savingMark}
        onCancel={() => setFeedbackOpen(false)}
        onOk={() => void submitFeedback()}
      >
        <TextArea
          rows={4}
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          placeholder={t("seg.feedbackPlaceholder")}
        />
      </Modal>
    </div>
  );
}
