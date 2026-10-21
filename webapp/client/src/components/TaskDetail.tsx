import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode,
} from "react";
import VirtualList, { type ListRef } from "rc-virtual-list";
import {
  Badge, Button, Checkbox, Dropdown, Empty, Input, Modal, Popover, Progress, Select, Space, Spin, Tag, theme, Tooltip, Typography, message, notification,
} from "antd";
import { DeleteOutlined, DownOutlined, DownloadOutlined, PauseOutlined, PlayCircleOutlined, SaveOutlined, SearchOutlined, SoundOutlined, SplitCellsOutlined, UpOutlined, WarningOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import {
  clearTaskErrors,
  getSegmentsPage,
  getTaskAudioMap,
  getTaskErrors,
  getTaskInfo,
  getTaskMarks,
  getTaskStatus,
  createCleanupJob,
  createExportJob,
  phoneticTask,
  prepareTask,
  pauseTask,
  resumeTask,
  searchSegments,
  getSearchHistory,
  addSearchHistory,
  setSegmentMark,
  stopTask,
  taskFileUrl,
  type MarkInfo,
  type SegmentMark,
  type SegmentSearchHit,
  type SearchHistoryItem,
  ttsTask,
  type ExportFormat,
  type ExportScope,
  type TaskErrorRow,
  updateSegment,
  type Segment,
  type TaskInfo,
  type TaskStatus,
} from "../api/client";
import { getErrorMessage } from "../lib/errors";
import { displayPercent } from "../lib/format";
import { LoadQueue, type LoadPriority } from "../lib/loadQueue";
import { STATUS_META } from "../lib/taskStatus";
import { textOnColor } from "../themes";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/locales";
import SegmentRow from "./SegmentRow";
import PlaybackBar from "./PlaybackBar";

const POLL_MS = 1800;

interface ChapterState {
  items: Segment[];
  total: number;
  offset: number;
  loading: boolean;
  error?: string;
}
const EMPTY_CHAPTER: ChapterState = { items: [], total: 0, offset: 0, loading: false };

function segTitle(name: string, fallback: string): string {
  // epub 的 source 形如 "text/part0000"/"text/part0000.html"，只显示文件名
  const base = name.split("/").pop() || name;
  const noExt = base.replace(/\.(x?html?)$/i, "");
  return noExt || base || fallback;
}

function isBusyTaskStatus(status?: TaskStatus | null): boolean {
  return status === "segmenting" || status === "running";
}

/** 左侧章节栏宽度与间距：右侧分段区左边界 = 宽度 + 间距。 */
const CHAPTER_PANE_WIDTH = 220;
const CHAPTER_PANE_GAP = 12;

/** 工具按钮配色由当前主题 token 派生（见组件内 inkBtnStyle / inkBtnStyleActive）。 */

interface MenuItemDef {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 统一下拉按钮：外观与「导出」一致——单个按钮，点击展开菜单（替代分裂式 Dropdown.Button）。
 * 「注音」「语音合成」「导出」共用本组件。
 */
function MenuButton({
  label, icon, items, onSelect, type = "primary", disabled, loading, tooltip, style,
}: {
  label: string;
  icon?: ReactNode;
  items: MenuItemDef[];
  onSelect: (key: string) => void;
  type?: "primary" | "default";
  disabled?: boolean;
  loading?: boolean;
  tooltip?: string;
  style?: CSSProperties;
}) {
  const node = (
    <Dropdown
      trigger={["click"]}
      disabled={disabled}
      menu={{
        items: items.map((it) => ({ key: it.key, label: it.label, danger: it.danger, disabled: it.disabled })),
        onClick: ({ key }) => onSelect(String(key)),
      }}
    >
      <Button size="small" type={type} icon={icon} loading={loading} disabled={disabled} style={style}>
        {label} <DownOutlined />
      </Button>
    </Dropdown>
  );
  return tooltip ? <Tooltip title={tooltip}><span>{node}</span></Tooltip> : node;
}



/** 虚拟列表行：章节标题 或 单个分段。 */
type RowItem =
  | { kind: "header"; key: string; source: string; total: number; loaded: number; loading: boolean }
  | { kind: "segment"; key: string; seg: Segment; index: number };

const ROW_HEADER_KEY = (source: string) => `__header__:${source}`;

export default function TaskDetail({ taskId, skipTts, reloadToken = 0 }: {
  taskId: number;
  skipTts: boolean;
  /** 变更后 +1 触发重新加载（如「配置」保存后）。 */
  reloadToken?: number;
}) {
  // i18n 的 t 取别名，避免与列表回调里的 t 冲突
  const { t: tr } = useI18n();
  const [info, setInfo] = useState<TaskInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  const [chapters, setChapters] = useState<Record<string, ChapterState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupWord, setCleanupWord] = useState("");
  const navigate = useNavigate();
  const [errorRows, setErrorRows] = useState<TaskErrorRow[]>([]);
  const errorCountRef = useRef(0);
  /** 分段标记：key → { mark, feedback } */
  const [marks, setMarks] = useState<Record<string, MarkInfo>>({});
  /** 按标记类型筛选：all | like | dislike */
  const [markFilter, setMarkFilter] = useState<"all" | SegmentMark>("all");
  const { token } = theme.useToken();
  /**
   * 主色浅底（colorPrimaryBg）上的文字色：按对比度自动取黑/白。
   * 例：极简黑白灰主题的 colorPrimaryBg 是中灰 (#606366)，此时应为白字，
   * 否则近黑字压在中灰上几乎看不清。
   */
  const onPrimaryBg = textOnColor(token.colorPrimaryBg);

  /** 工具按钮统一配色：全部随当前主题 token 变化。 */
  const inkBtnStyle: CSSProperties = {
    background: token.colorPrimaryBg,
    borderColor: token.colorPrimaryBorder,
    color: onPrimaryBg,
  };
  const inkBtnStyleActive: CSSProperties = {
    background: token.colorPrimaryBorder,
    borderColor: token.colorPrimary,
    color: onPrimaryBg,
  };
  const [ttsLoading, setTtsLoading] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [phoneticLoading, setPhoneticLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [savingAll, setSavingAll] = useState(false);
  const [audioRefreshToken, setAudioRefreshToken] = useState(0);
  const [serverRefreshToken, setServerRefreshToken] = useState(0);
  const [skipExisting, setSkipExisting] = useState(true);
  const [listHeight, setListHeight] = useState(480);
  const [playing, setPlaying] = useState<{ key: string; url: string; source: string } | null>(null);
  /** 音频加载/播放中：让后台预取让路，保证播放优先。 */
  const [audioActive, setAudioActive] = useState(false);
  /** 播放器状态：是否正在播放、是否连播、当前进度与总时长（秒）。 */
  const [isPlaying, setIsPlaying] = useState(false);
  const [continuous, setContinuous] = useState(true);
  const [audioCurrent, setAudioCurrent] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  /** 置顶显示当前滚动位置所属章节（虚拟列表顶部行的章节）。 */
  const [pinned, setPinned] = useState<{ source: string; isHeader: boolean } | null>(null);
  /** 原文搜索。 */
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wildcard, setWildcard] = useState(false);
  const [searchHits, setSearchHits] = useState<SegmentSearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  /** 每次「上一个/下一个」自增：即使命中项不变（如只有 1 个结果）也能重新定位。 */
  const [hitJumpToken, setHitJumpToken] = useState(0);
  /** 该任务的搜索历史（最多最近 100 条，默认展示 10 条）。 */
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  /** 搜索框聚焦时展示历史下拉。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  /** 未保存的编辑草稿：虚拟滚动卸载行后，重新挂载时据此恢复。 */
  const draftsRef = useRef(new Map<string, { text: string; phonetic: string }>());
  const listBoxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<ListRef | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 章节分段加载队列：后台预取 + 用户点击提升 + 播放时让路。
  const queueRef = useRef<LoadQueue | null>(null);
  if (!queueRef.current) queueRef.current = new LoadQueue({ user: 3, background: 1 });
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const activeKeysRef = useRef(activeKeys);
  activeKeysRef.current = activeKeys;
  const infoRef = useRef(info);
  infoRef.current = info;
  const loadedRef = useRef<Set<string>>(new Set());
  const pollTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const pollStatusRef = useRef<() => Promise<void>>(async () => {});

  /**
   * 记录/清除未保存的编辑草稿。草稿保存在 ref 中（不触发整表重渲染），
   * 且是 dirty 的唯一来源，这样即使虚拟列表把该行卸载也不会丢修改。
   */
  const handleDraft = useCallback((key: string, text: string, phonetic: string, dirty: boolean) => {
    const had = draftsRef.current.has(key);
    if (dirty) draftsRef.current.set(key, { text, phonetic });
    else draftsRef.current.delete(key);
    const has = draftsRef.current.has(key);
    if (had !== has) setDirtyCount((c) => c + (has ? 1 : -1));
  }, []);

  const playSegment = useCallback((key: string, url: string, source: string) => {
    setPlaying({ key, url, source });
    setAudioCurrent(0);
    setAudioDuration(0);
    // 播放最高优先：立即让后台预取让路，把连接/带宽留给音频。
    setAudioActive(true);
    // 跟随滚动：先展开所在章节，行进入虚拟列表后再定位。
    if (source && !activeKeysRef.current.includes(source)) {
      activeKeysRef.current = [...activeKeysRef.current, source];
      setActiveKeys(activeKeysRef.current);
    }
    window.setTimeout(() => { void audioRef.current?.play().catch(() => {}); }, 0);
    let attempts = 0;
    const tryScroll = () => {
      if (rowsRef.current.some((row) => row.key === key)) {
        listRef.current?.scrollTo({ key, align: "auto" });
        return;
      }
      if (attempts++ < 30) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
  }, []);

  // 音频加载/播放期间收敛加载队列并发（见 LoadQueue.setPlaying）。
  useEffect(() => {
    queueRef.current?.setPlaying(audioActive);
  }, [audioActive]);

  /** 直接拉取某章全部分段（不做队列调度；调度见 scheduleChapter）。 */
  const fetchChapter = useCallback(async (src: string, force = false): Promise<Segment[]> => {
    const existing = chaptersRef.current[src];
    if (loadedRef.current.has(src) && !force) return existing?.items ?? [];
    setChapters((p) => ({
      ...p,
      [src]: { ...(p[src] || EMPTY_CHAPTER), loading: true, error: undefined },
    }));
    loadedRef.current.add(src);
    try {
      const page = await getSegmentsPage(taskId, src, 0);
      setChapters((p) => ({
        ...p,
        [src]: {
          items: page.items,
          total: page.total,
          offset: page.items.length,
          loading: false,
        },
      }));
      return page.items;
    } catch (error) {
      loadedRef.current.delete(src);
      setChapters((p) => ({ ...p, [src]: { ...(p[src] || EMPTY_CHAPTER), loading: false, error: getErrorMessage(error, tr("error.request")) } }));
      return [];
    }
  }, [taskId, tr]);

  /** 经优先级队列加载某章：后台预取 / 用户点击（可把已排队的后台任务提升重排）。 */
  const scheduleChapter = useCallback(
    (src: string, priority: LoadPriority, force = false): Promise<Segment[]> => {
      const queue = queueRef.current!;
      if (force) return queue.schedule(`refresh:${src}`, "user", () => fetchChapter(src, true));
      return queue.schedule(`chapter:${src}`, priority, () => fetchChapter(src, false));
    },
    [fetchChapter],
  );

  const refreshLoadedChapters = useCallback(async () => {
    const sources = [...loadedRef.current];
    await Promise.all(sources.map((source) => scheduleChapter(source, "user", true)));
  }, [scheduleChapter]);

  /**
   * 单段保存成功后刷新所属章节（只更新该章数据，避免 serverRefreshToken
   * 触发其他未保存行的本地编辑被重置）。
   */
  const handleSegmentSaved = useCallback(async (source: string) => {
    await scheduleChapter(source, "user", true);
  }, [scheduleChapter]);

  /**
   * 保存所有草稿。以 draftsRef 为准，因此对已被虚拟列表卸载的段落同样生效。
   * 保存后重新拉取已加载章节，让各行以服务端值刷新、清除 dirty 状态。
   */
  const saveAll = useCallback(async (opts?: { silentIfClean?: boolean }) => {
    const entries = [...draftsRef.current.entries()];
    if (!entries.length) {
      if (!opts?.silentIfClean) message.warning(tr("detail.noChanges"));
      return true;
    }
    // 只刷新真正被修改的章节，避免保存时重拉全部章节。
    const dirtyKeys = new Set(entries.map(([key]) => key));
    const affectedSources = new Set<string>();
    for (const [src, st] of Object.entries(chaptersRef.current)) {
      if (st.items.some((item) => dirtyKeys.has(item.key))) affectedSources.add(src);
    }

    setSavingAll(true);
    let ok = 0;
    try {
      for (const [key, draft] of entries) {
        await updateSegment(taskId, key, draft);
        draftsRef.current.delete(key);
        ok++;
      }
      setDirtyCount(0);
      await Promise.all([...affectedSources].map((src) => scheduleChapter(src, "user", true)));
      setServerRefreshToken((value) => value + 1);
      message.success(tr("detail.savedCount", { count: ok }));
      return true;
    } catch (error) {
      message.error(getErrorMessage(error, tr("error.request")));
      return false;
    } finally { setSavingAll(false); }
  }, [scheduleChapter, taskId, tr]);

  const resetLoadedState = useCallback((clearSelection = false) => {
    loadedRef.current = new Set();
    chaptersRef.current = {};
    draftsRef.current.clear();
    setDirtyCount(0);
    setChapters({});
    setActiveKeys([]);
    if (clearSelection) setSelected(new Set());
  }, []);

  /**
   * 用服务端权威的「分段 → 当前音频文件名」映射同步各行的「播放」按钮。
   * 同一分段序号可能同时存在多个不同 hash 的历史音频，只有服务端按当前内容 hash
   * 命中的那一个才算数，客户端不做任何文件名猜测。
   */
  const syncAudioNames = useCallback((map: Record<string, string>) => {
    const currentChapters = chaptersRef.current;
    let changed = false;
    const nextChapters: Record<string, ChapterState> = {};
    for (const [src, chapter] of Object.entries(currentChapters)) {
      let chapterChanged = false;
      const nextItems = chapter.items.map((item) => {
        const nextAudio = map[item.key] ?? null;
        if (nextAudio === item.audio) return item;
        chapterChanged = true;
        changed = true;
        return { ...item, audio: nextAudio };
      });
      nextChapters[src] = chapterChanged ? { ...chapter, items: nextItems } : chapter;
    }
    if (!changed) return;

    chaptersRef.current = nextChapters;
    setChapters(nextChapters);
    setAudioRefreshToken((value) => value + 1);
  }, []);

  const load = useCallback(async (opts?: { resetChapters?: boolean; clearSelection?: boolean }) => {
    setLoading(true);
    setError(null);
    if (opts?.resetChapters) resetLoadedState(Boolean(opts.clearSelection));
    try {
      const inf = await getTaskInfo(taskId);
      setInfo(inf);
      const errs = await getTaskErrors(taskId).catch(() => [] as TaskErrorRow[]);
      errorCountRef.current = errs.length;
      setErrorRows(errs);
      setMarks(await getTaskMarks(taskId).catch(() => ({})));
      // 打开即展开全部章节并加载其所有分段（不设 50 段/章 上限）。
      const nextActiveKeys = [...inf.sources];
      activeKeysRef.current = nextActiveKeys;
      setActiveKeys(nextActiveKeys);
      if (!inf.sources.length) return;

      // 首章优先（打开即可见），其余章节按源顺序低优先后台预取。
      // 并发由 LoadQueue 双泳道限流，打开后不会一次性占满连接。
      inf.sources.forEach((source, index) => {
        void scheduleChapter(source, index === 0 ? "user" : "background");
      });
    } catch (loadError) {
      setError(getErrorMessage(loadError, tr("error.request")));
    } finally {
      setLoading(false);
    }
  }, [resetLoadedState, scheduleChapter, taskId, tr]);

  useEffect(() => {
    void load({ resetChapters: true, clearSelection: true });
  }, [load, reloadToken]);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const scheduleNextPoll = useCallback((delay = POLL_MS, busyOverride?: boolean) => {
    clearPollTimer();
    const busy = busyOverride ?? isBusyTaskStatus(infoRef.current?.status);
    if (!mountedRef.current || !busy) return;

    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      void pollStatusRef.current();
    }, delay);
  }, [clearPollTimer]);

  const pollStatus = useCallback(async () => {
    const currentInfo = infoRef.current;
    if (!currentInfo) return;

    try {
      const status = await getTaskStatus(taskId);
      setInfo((prev) => (prev ? {
        ...prev,
        status: status.status,
        progress: status.progress,
        error: status.error,
        segmentCount: status.segment_count,
      } : prev));

      // 只要仍在分段/合成，就继续轮询进度（否则进度条不会更新）。
      scheduleNextPoll(POLL_MS, isBusyTaskStatus(status.status));

      // 错误数变化时才拉取错误历史（避免每次轮询都请求）
      if (status.error_count !== errorCountRef.current) {
        errorCountRef.current = status.error_count;
        void getTaskErrors(taskId).then(setErrorRows).catch(() => {});
      }

      if (status.status === "segmenting") {
        return;
      }

      if (status.status === "running") {
        if (currentInfo.sources.length > 0) {
          syncAudioNames(await getTaskAudioMap(taskId));
        }
        return;
      }

      if (currentInfo.sources.length === 0 && status.segment_count > 0) {
        await load({ resetChapters: true, clearSelection: true });
        return;
      }

      const latestInfo = await getTaskInfo(taskId);
      setInfo(latestInfo);
      if (latestInfo.sources.length > 0) {
        syncAudioNames(await getTaskAudioMap(taskId));
      }
    } catch (pollError) {
      message.open({ key: `task-detail-poll-${taskId}`, type: "error", content: getErrorMessage(pollError, tr("error.request")) });
      scheduleNextPoll();
    }
  }, [load, scheduleNextPoll, syncAudioNames, taskId]);

  pollStatusRef.current = pollStatus;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  // 虚拟列表需要固定高度的滚动容器：跟随可用空间自适应。
  useEffect(() => {
    const el = listBoxRef.current;
    if (!el) return;
    const apply = () => setListHeight(Math.max(200, el.clientHeight));
    apply();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", apply);
      return () => window.removeEventListener("resize", apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [info, loading, error]);

  useEffect(() => {
    if (!isBusyTaskStatus(info?.status)) {
      clearPollTimer();
      return undefined;
    }

    scheduleNextPoll();
    return clearPollTimer;
  }, [clearPollTimer, info, scheduleNextPoll]);

  const onCollapse = (keys: string | string[]) => {
    const nextKeys = Array.isArray(keys) ? keys : [keys];
    const prevKeys = activeKeysRef.current;
    activeKeysRef.current = nextKeys;
    setActiveKeys(nextKeys);
    const opened = nextKeys.filter((key) => !prevKeys.includes(key) && !(chaptersRef.current[key] && chaptersRef.current[key].loading));
    opened.forEach((k) => {
      const st = chaptersRef.current[k];
      if (!st || st.items.length === 0) void scheduleChapter(k, "user");
    });
  };

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /** 选中/取消选中某章节的全部段落（章节折叠或尚未加载时也生效）。 */
  const toggleSource = async (src: string) => {
    let items = chaptersRef.current[src]?.items ?? [];
    if (items.length === 0) {
      console.log(`📖 章节 ${src} 尚未加载，先加载全部段落再选择`);
      items = await scheduleChapter(src, "user");
    }
    const keys = items.map((x) => x.key);
    console.log(`🔄 章节 ${src}: 共 ${keys.length} 段`);
    setSelected((prev) => {
      const next = new Set(prev);
      const all = keys.length > 0 && keys.every((k) => next.has(k));
      for (const k of keys) { if (all) next.delete(k); else next.add(k); }
      console.log(`📊 当前共选中 ${next.size} 段`);
      return next;
    });
  };

  /**
   * 重新分段：分段尺寸等参数取自任务设置，这里不再让用户选择或改动「跳过语音合成」，
   * 只用 Notification 告知分段长度与「已有语音可能不再匹配」的后果。
   */
  const startPrepare = useCallback(async () => {
    setPreparing(true);
    try {
      const result = await prepareTask(taskId);
      message.success(result.message || tr("detail.resegmentStarted"));
      notification.warning({
        key: `resegment-${taskId}`,
        message: tr("detail.resegmentStartedTitle"),
        duration: 8,
        description: (
          <div style={{ fontSize: 12, lineHeight: "20px" }}>
            <div>{tr("detail.segmentLength", { chars: info?.maxChars ?? "-" })}</div>
            <div>{tr("detail.resegmentNotice")}</div>
          </div>
        ),
      });
      resetLoadedState(true);
      setError(null);
      setInfo((prev) => (prev ? {
        ...prev,
        status: "segmenting",
        progress: 0,
        error: null,
        sources: [],
        segmentCount: 0,
      } : {
        text: "",
        sources: [],
        segmentCount: 0,
        status: "segmenting",
        progress: 0,
        error: null,
        maxChars: 0,
      }));
      // 分段在后台线程执行，前端持续轮询进度。
      void pollStatus();
    } catch (prepareError) {
      console.error("❌ 重新分段失败:", prepareError);
      message.error(getErrorMessage(prepareError, tr("error.request")));
    } finally {
      setPreparing(false);
    }
  }, [info?.maxChars, pollStatus, resetLoadedState, taskId, tr]);

  const startTts = useCallback(async (scope: "all" | "selected") => {
    if (skipTts) {
      message.warning(tr("detail.disabledNoModel"));
      return;
    }
    // 分段中不可合成；运行中允许提交（服务端排队串行执行）。
    if (!info || info.status === "segmenting") {
      return;
    }
    if (info.sources.length === 0) {
      message.warning(tr("detail.mustResegment"));
      return;
    }

    const keys = scope === "selected" ? [...selected] : undefined;
    if (scope === "selected" && (!keys || keys.length === 0)) {
      message.warning(tr("detail.selectSegmentsToSynth"));
      return;
    }

    if (dirtyCount > 0) {
      const saved = await saveAll({ silentIfClean: true });
      if (!saved) return;
    }

    setTtsLoading(true);
    try {
      const result = await ttsTask(taskId, keys, skipExisting);
        message.success(result.message || (scope === "selected" ? tr("detail.ttsStartedSelected") : tr("detail.ttsStartedAll")));
      setInfo((prev) =>
        prev ? { ...prev, status: "running", progress: prev.status === "running" ? prev.progress : 0, error: null } : prev
      );
      void pollStatus();
    } catch (ttsError) {
      message.error(getErrorMessage(ttsError, tr("error.request")));
    } finally {
      setTtsLoading(false);
    }
  }, [dirtyCount, info, pollStatus, saveAll, selected, skipExisting, skipTts, taskId, tr]);

  const stopRunning = useCallback(async () => {
    try {
      const result = await stopTask(taskId);
      message.success(result.message || tr("detail.stopRequested"));
      setInfo((prev) => (prev ? { ...prev, status: "ready" } : prev));
      void pollStatus();
    } catch (stopError) {
      message.error(getErrorMessage(stopError, tr("error.request")));
    }
  }, [pollStatus, taskId, tr]);

  const pauseRunning = useCallback(async () => {
    setPauseLoading(true);
    try {
      const result = await pauseTask(taskId);
      message.success(result.message || tr("detail.paused"));
      setInfo((prev) => (prev ? { ...prev, status: "paused" } : prev));
      void pollStatus();
    } catch (pauseError) {
      message.error(getErrorMessage(pauseError, tr("error.request")));
    } finally {
      setPauseLoading(false);
    }
  }, [pollStatus, taskId, tr]);

  const continueRunning = useCallback(async () => {
    setResumeLoading(true);
    try {
      const result = await resumeTask(taskId);
      message.success(result.message || tr("detail.resumed"));
      setInfo((prev) => (prev ? { ...prev, status: "running", error: null } : prev));
      void pollStatus();
    } catch (resumeError) {
      message.error(getErrorMessage(resumeError, tr("error.request")));
    } finally {
      setResumeLoading(false);
    }
  }, [pollStatus, taskId, tr]);

  const startPhonetic = useCallback(async (scope: "all" | "selected") => {
    if (!info || info.status === "segmenting" || info.status === "running") return;
    if (info.sources.length === 0) {
      message.warning(tr("detail.mustResegment"));
      return;
    }

    const keys = scope === "selected" ? [...selected] : undefined;
    if (scope === "selected" && (!keys || keys.length === 0)) {
      message.warning(tr("detail.selectSegmentsToPhonetic"));
      return;
    }

    if (dirtyCount > 0) {
      const saved = await saveAll({ silentIfClean: true });
      if (!saved) return;
    }

    setPhoneticLoading(true);
    try {
      const result = await phoneticTask(taskId, keys);
      await refreshLoadedChapters();
      setServerRefreshToken((value) => value + 1);
      message.success(tr("detail.phoneticDone", { count: result.updated }));
    } catch (phoneticError) {
      message.error(getErrorMessage(phoneticError, tr("error.request")));
    } finally {
      setPhoneticLoading(false);
    }
  }, [dirtyCount, info, refreshLoadedChapters, saveAll, selected, taskId, tr]);

  /** 导出：创建后台导出任务，进度见「文件传输」页。菜单 key 形如 "<scope>-<format>"。 */
  const doExport = async (menuKey: string) => {
    const [scope, format] = menuKey.split("-") as [ExportScope, ExportFormat];
    if (scope === "selected" && selected.size === 0) {
      message.warning(tr("detail.selectSegmentsToExport"));
      return;
    }
    setExporting(true);
    try {
      await createExportJob(taskId, {
        scope,
        format,
        keys: scope === "selected" ? [...selected] : undefined,
      });
      message.success(tr("transfer.exportStarted"));
      navigate(`/tasks/${taskId}?tab=transfer`);
    } catch (error) {
      message.error(getErrorMessage(error, tr("error.request")));
    } finally {
      setExporting(false);
    }
  };

  /** 清理分段音频：unused=删除非最新旧副本；all=删除全部（需输入 delete 确认）。 */
  const doCleanup = async (mode: "unused" | "all") => {
    try {
      await createCleanupJob(taskId, mode);
      message.success(tr("transfer.cleanupStarted"));
      navigate(`/tasks/${taskId}?tab=transfer`);
    } catch (error) {
      message.error(getErrorMessage(error, tr("error.request")));
    }
  };

  /** 点赞 / 点踩（可附反馈，反馈可为空）：写入后端并同步本地标记。 */
  const handleMarked = useCallback(
    async (key: string, mark: SegmentMark | null, feedback: string) => {
      try {
        const res = await setSegmentMark(taskId, key, mark, feedback);
        setMarks(res.marks);
      } catch (error) {
        message.error(getErrorMessage(error, tr("error.request")));
      }
    },
    [taskId],
  );

  const statusMeta = info ? STATUS_META[info.status] : STATUS_META.idle;
  const needsResegmentBeforeTts = Boolean(
    info && info.sources.length === 0 && info.status !== "segmenting" && info.status !== "running"
  );
  const ttsDisabledReason = skipTts
    ? tr("detail.disabledNoModel")
    : info?.status === "segmenting"
      ? tr("detail.disabledSegmenting")
      : info?.status === "running"
        ? tr("detail.disabledRunning")
        : needsResegmentBeforeTts
          ? tr("detail.mustResegment")
        : undefined;
  const phoneticDisabledReason = info?.status === "segmenting"
    ? tr("detail.disabledSegmenting")
    : info?.status === "running"
      ? tr("detail.disabledRunning")
      : needsResegmentBeforeTts
        ? tr("detail.mustResegment")
        : undefined;
  const ttsItems: MenuItemDef[] =
    info?.status === "running"
      ? [
          { key: "pause", label: tr("detail.ttsPause") },
          { key: "stop", label: tr("detail.ttsStop"), danger: true },
        ]
      : info?.status === "paused"
        ? [
            { key: "resume", label: tr("detail.ttsResume") },
            { key: "stop", label: tr("detail.ttsStop"), danger: true },
          ]
        : [
            { key: "all", label: tr("detail.ttsAll") },
            { key: "selected", label: tr("detail.ttsSelected"), disabled: selected.size === 0 },
          ];
  const ttsButton = (
    <MenuButton
      label={info?.status === "running" ? tr("detail.ttsPauseShort") : info?.status === "paused" ? tr("detail.ttsResumeShort") : tr("detail.ttsLabel")}
      icon={info?.status === "running" ? <PauseOutlined /> : <PlayCircleOutlined />}
      loading={info?.status === "running" ? pauseLoading : info?.status === "paused" ? resumeLoading : ttsLoading}
      items={ttsItems}
      onSelect={(key) => {
        if (key === "pause") void pauseRunning();
        else if (key === "resume") void continueRunning();
        else if (key === "stop") void stopRunning();
        else void startTts(key === "selected" ? "selected" : "all");
      }}
      disabled={info?.status === "running" || info?.status === "paused" ? false : Boolean(ttsDisabledReason)}
      tooltip={info?.status === "running" || info?.status === "paused" ? undefined : ttsDisabledReason}
      type="default"
      style={inkBtnStyle}
    />
  );
  const showStatusOnly = Boolean(
    info && info.sources.length === 0 && (info.status === "segmenting" || info.status === "running")
  );
  const showMissingSegments = Boolean(
    info && info.sources.length === 0 && info.status !== "segmenting" && info.status !== "running"
  );

  // 展平为章节标题行 + 分段行，交给虚拟列表；只有可视区域的行会真正挂载。
  const rows = useMemo<RowItem[]>(() => {
    const out: RowItem[] = [];
    for (const src of info?.sources ?? []) {
      const st = chapters[src] || EMPTY_CHAPTER;
      out.push({
        kind: "header",
        key: ROW_HEADER_KEY(src),
        source: src,
        total: st.total,
        loaded: st.items.length,
        loading: st.loading,
      });
      if (!activeKeys.includes(src)) continue;
      st.items.forEach((seg, i) => {
        out.push({ kind: "segment", key: seg.key, seg, index: i });
      });
    }
    return out;
  }, [activeKeys, chapters, info?.sources]);

  /**
   * 有序可播列表（跨章节、仅含有音频的分段）：连播 / 上一段 / 下一段均基于它。
   * 用 chapters 而非 rows：折叠章节里的分段也要参与连播。
   */
  const playableSegments = useMemo(() => {
    const list: { key: string; url: string; source: string }[] = [];
    for (const src of info?.sources ?? []) {
      for (const seg of chapters[src]?.items ?? []) {
        if (seg.audio) list.push({ key: seg.key, url: taskFileUrl(taskId, seg.audio), source: src });
      }
    }
    return list;
  }, [chapters, info?.sources, taskId]);
  const playableIndex = useMemo(
    () => new Map(playableSegments.map((item, i) => [item.key, i])),
    [playableSegments]
  );

  /** 上一段 / 下一段：按 playableIndex 取相邻项（±1）。 */
  const playAdjacent = useCallback((delta: number) => {
    if (!playing) return;
    const i = playableIndex.get(playing.key);
    if (i === undefined) return;
    const target = playableSegments[i + delta];
    if (target) playSegment(target.key, target.url, target.source);
  }, [playableIndex, playableSegments, playSegment, playing]);

  /** 播放结束 / 出错：连播且存在下一段则续播，否则停止（保留播放条）。 */
  const goNextOrStop = useCallback(() => {
    if (continuous && playing) {
      const i = playableIndex.get(playing.key);
      const next = i === undefined ? undefined : playableSegments[i + 1];
      if (next) { playSegment(next.key, next.url, next.source); return; }
    }
    setIsPlaying(false);
    setAudioActive(false);
  }, [continuous, playableIndex, playableSegments, playSegment, playing]);

  const handleAudioEnded = useCallback(() => { goNextOrStop(); }, [goNextOrStop]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !playing) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }, [playing]);

  /** 行的「播放」按钮：点当前播放段 = 暂停/继续；点其他段 = 从该段重新连播。 */
  const handleRowPlay = useCallback((key: string, url: string, source: string) => {
    if (playing && playing.key === key) { togglePlay(); return; }
    playSegment(key, url, source);
  }, [playSegment, playing, togglePlay]);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setPlaying(null);
    setIsPlaying(false);
    setAudioActive(false);
    setAudioCurrent(0);
    setAudioDuration(0);
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = seconds;
  }, []);

  // 原文搜索 / 按标记类型筛选：防抖调用服务端在整篇分段中检索。
  useEffect(() => {
    const query = searchQuery.trim();
    const mark = markFilter === "all" ? null : markFilter;
    if (!query && !mark) {
      setSearchHits([]);
      setHitIndex(0);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchSegments(taskId, { query, caseSensitive, wildcard, mark })
        .then((res) => {
          if (cancelled) return;
          setSearchHits(res.results);
          setHitIndex(0);
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchHits([]);
          message.error(getErrorMessage(error, tr("error.request")));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [taskId, searchQuery, caseSensitive, wildcard, markFilter]);

  // 载入该任务的搜索历史
  useEffect(() => {
    let cancelled = false;
    getSearchHistory(taskId)
      .then((res) => {
        if (!cancelled) setSearchHistory(res.items);
      })
      .catch(() => {
        /* 历史加载失败不影响搜索本身 */
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // 搜索稳定 1 秒且有命中后写入历史，避免把输入中间态也记进去
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !searchHits.length) return;
    const timer = window.setTimeout(() => {
      void addSearchHistory(taskId, {
        query,
        caseSensitive,
        wildcard,
        mark: markFilter === "all" ? "" : markFilter,
      })
        .then((res) => setSearchHistory(res.items))
        .catch(() => {
          /* 记录失败忽略 */
        });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [taskId, searchQuery, caseSensitive, wildcard, markFilter, searchHits.length]);

  /** 点击历史记录：恢复该次搜索的查询与选项。 */
  const applyHistory = (item: SearchHistoryItem) => {
    setCaseSensitive(item.caseSensitive);
    setWildcard(item.wildcard);
    setMarkFilter((item.mark || "all") as "all" | SegmentMark);
    setSearchQuery(item.query);
  };

  const currentHit = searchHits.length
    ? searchHits[Math.min(hitIndex, searchHits.length - 1)]
    : null;

  // rows 的最新值（供定位 effect 读取，避免把 rows 放进依赖而随轮询反复触发）
  const rowsRef = useRef<RowItem[]>([]);
  rowsRef.current = rows;

  /** 后台预取恢复计时器（跳转定位后短暂暂停，避免上方插行顶走定位）。 */
  const backgroundResumeRef = useRef<number | null>(null);

  /**
   * 定位到某一行（章节标题或分段）：
   * - 把目标章节提升为 user 优先级（重排队列）并确保已加载、已展开；
   * - 跳转期间暂停后台预取，并从目标章节往后排，避免在视口上方插入行；
   * - 用行 key（而非 index）定位，再短暂停顿后恢复后台预取。
   */
  const locateRow = useCallback(
    async (src: string, rowKey: string) => {
      const queue = queueRef.current!;
      queue.setBackgroundPaused(true);
      const sources = infoRef.current?.sources ?? [];
      const index = sources.indexOf(src);
      if (index >= 0) {
        queue.setBackgroundOrder([...sources.slice(index + 1), ...sources.slice(0, index)]);
      }
      if (!chaptersRef.current[src]?.items?.length) {
        await scheduleChapter(src, "user");
      }
      activeKeysRef.current = activeKeysRef.current.includes(src)
        ? activeKeysRef.current
        : [...activeKeysRef.current, src];
      setActiveKeys((prev) => (prev.includes(src) ? prev : [...prev, src]));

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      let attempts = 0;
      const tryScroll = () => {
        if (rowsRef.current.some((row) => row.key === rowKey)) {
          listRef.current?.scrollTo({ key: rowKey, align: "top" });
          return;
        }
        // 章节刚展开、行尚未进入 rows 时短暂等待重试。
        if (attempts++ < 30) requestAnimationFrame(tryScroll);
      };
      tryScroll();

      if (backgroundResumeRef.current !== null) window.clearTimeout(backgroundResumeRef.current);
      backgroundResumeRef.current = window.setTimeout(() => {
        backgroundResumeRef.current = null;
        queueRef.current?.setBackgroundPaused(false);
      }, 1200);
    },
    [scheduleChapter],
  );

  useEffect(() => {
    if (!currentHit) return;
    void locateRow(currentHit.source, currentHit.key);
    // 只在命中项变化（或点了上一个/下一个）时定位一次；rows/数据通过 ref 读取最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHit?.key, hitJumpToken, locateRow]);

  useEffect(
    () => () => {
      if (backgroundResumeRef.current !== null) window.clearTimeout(backgroundResumeRef.current);
    },
    []
  );

  // 记录虚拟列表顶部可见行所属的章节，用于固定在列表首行展示。
  const handleVisibleChange = useCallback((visible: RowItem[]) => {
    if (!visible.length) {
      setPinned(null);
      return;
    }
    // rc-virtual-list 判断首个可见行用「bottom >= scrollTop」，因此在按 key 精确滚动
    // （align: top，如点击左侧章节跳转）时，会把「底部恰好等于滚动位置」的上一章最后一段
    // 也算作首个可见行，导致固定的章节比实际滚动到的章节早一章（点击章节选中上一章）。
    // 若首个可见行是分段且其后紧邻下一章标题，说明滚动位置正好停在章节边界，应以该标题为准。
    let first = visible[0];
    if (first.kind === "segment" && visible[1]?.kind === "header") {
      first = visible[1];
    }
    const next = {
      source: first.kind === "header" ? first.source : first.seg.source,
      isHeader: first.kind === "header",
    };
    setPinned((prev) =>
      prev && prev.source === next.source && prev.isHeader === next.isHeader ? prev : next
    );
  }, []);

  /** 左侧章节列表点击：提升并加载该章，然后稳定定位到它的标题行。 */
  const jumpToChapter = useCallback(
    (src: string) => {
      void locateRow(src, ROW_HEADER_KEY(src));
    },
    [locateRow],
  );

  /** 章节可折叠标题行（列表内与置顶吸附共用同一组件，保证外观与交互一致）。 */
  const renderChapterHeader = (src: string, isPinned = false) => {
    const st = chapters[src] || EMPTY_CHAPTER;
    const loadedKeys = st.items.map((x) => x.key);
    const checked = loadedKeys.length > 0 && loadedKeys.every((key) => selected.has(key));
    const partial = !checked && loadedKeys.some((key) => selected.has(key));
    const expanded = activeKeys.includes(src);
    const chapterDone = st.items.filter((x) => x.audio).length;
    const ratio = st.total > 0 ? chapterDone / st.total : 0;
    return (
      <div
        onClick={() => onCollapse(expanded ? activeKeys.filter((k) => k !== src) : [...activeKeys, src])}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          padding: "6px 10px",
          margin: isPinned ? "0 0 2px" : "6px 0 2px",
          background: token.colorPrimaryBg,
          borderRadius: 8,
          border: `3px solid ${token.colorPrimary}`,
        }}
      >
        <span style={{ width: 12, color: onPrimaryBg }}>{expanded ? "▾" : "▸"}</span>
        <Checkbox
          checked={checked}
          indeterminate={partial}
          onClick={(event) => event.stopPropagation()}
          onChange={() => void toggleSource(src)}
        />
        <Typography.Text strong style={{ fontSize: 15, color: onPrimaryBg }}>{segTitle(src, tr("detail.bodyText"))}</Typography.Text>
        {st.loading ? (
          <Tag>{tr("detail.loadingTag")}</Tag>
        ) : (
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: onPrimaryBg,
              // 已合成比例越高，字色越实
              opacity: 0.5 + 0.5 * ratio,
            }}
          >
            {chapterDone}/{st.total}
          </span>
        )}
        {st.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{st.error}</Typography.Text>}
      </div>
    );
  };

  const loadedKeys = useMemo(
    () => Object.values(chapters).flatMap((c) => c.items.map((x) => x.key)),
    [chapters]
  );
  const allLoadedSelected = loadedKeys.length > 0 && loadedKeys.every((key) => selected.has(key));

  /**
   * 虚拟列表行高估算：SegmentRow 的行高主要取决于编辑器行数（autoSize 1~8 行，行高 22）。
   * 按任务的分段长度上限推算，估算值贴近实际上限，避免估算过小导致滚动条提前到底、
   * 最后几行滚不出来（rc-virtual-list 用该值给未测量行定位）。
   */
  const estimatedRowHeight = useMemo(() => {
    const maxChars = Number(info?.maxChars) || 100;
    const lines = Math.min(8, Math.max(1, Math.ceil(maxChars / 40)));
    return 82 + lines * 22; // 结构固定部分(约82) + 编辑器文本行
  }, [info?.maxChars]);

  /** 已完成合成的分段数（有音频的分段）。 */
  const doneCount = useMemo(
    () =>
      Object.values(chapters).reduce(
        (sum, chapter) => sum + chapter.items.reduce((n, item) => n + (item.audio ? 1 : 0), 0),
        0
      ),
    [chapters]
  );
  const totalSegments = info?.segmentCount ?? 0;
  /** 进度条内文字：分段数 > 1 时附带「已完成/总分段数」。 */
  const progressText = (percent?: number) => {
    const p = displayPercent(percent ?? info?.progress ?? 0);
    return totalSegments > 1 ? `${p}%  ${doneCount}/${totalSegments}` : `${p}%`;
  };

  // 播放条派生值：当前段在可播列表中的位置、可用的上一段/下一段、以及「正在播放」文案。
  const playablePos = playing ? playableIndex.get(playing.key) : undefined;
  const hasPrev = playablePos !== undefined && playablePos > 0;
  const hasNext = playablePos !== undefined && playablePos < playableSegments.length - 1;
  const playbackLabel = playing
    ? tr("detail.nowPlaying", { key: playing.key, chapter: segTitle(playing.source, tr("detail.bodyText")) })
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {loading ? (
        <div style={{ textAlign: "center", padding: 48 }}><Spin tip={tr("detail.loadingChapters")} /></div>
      ) : error ? (
        <Empty description={error} style={{ padding: 32 }}>
          <Button type="primary" onClick={() => void load({ resetChapters: false, clearSelection: false })}>{tr("act.retry")}</Button>
        </Empty>
      ) : info && (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div className="flat-card task-detail-toolbar" style={{ padding: 12, borderRadius: 12, marginBottom: 12, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", flex: "0 0 auto" }}>
            <Space wrap>
                      <Tag color={statusMeta.color}>{tr(`st.${info?.status ?? "idle"}` as keyof Messages)}</Tag>
              {skipTts && <Tag color="cyan">{tr("detail.segmentOnly")}</Tag>}
              {errorRows.length > 0 && (
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  title={
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                      <span>{tr("detail.errorHistory", { count: errorRows.length })}</span>
                      <Button
                        size="small"
                        danger
                        onClick={async () => {
                          try {
                            await clearTaskErrors(taskId);
                            errorCountRef.current = 0;
                            setErrorRows([]);
                            message.success(tr("detail.errorHistoryCleared"));
                          } catch (e) {
                            message.error(getErrorMessage(e, tr("error.request")));
                          }
                        }}
                      >
                        {tr("act.clear")}
                      </Button>
                    </div>
                  }
                  content={
                    <div style={{ maxHeight: 360, width: 520, overflow: "auto" }}>
                      {errorRows.map((row) => (
                        <div key={row.id} style={{ padding: "6px 0", borderBottom: `1px solid ${token.colorBorderSecondary}`, }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {row.created_at} · {row.stage}
                          </Typography.Text>
                          <div style={{ fontSize: 12, wordBreak: "break-word" }}>{row.message}</div>
                        </div>
                      ))}
                    </div>
                  }
                >
                  <Button size="small" danger icon={<WarningOutlined />} aria-label={tr("detail.errorHistoryAria")}>
                    {tr("st.error")} <Badge count={errorRows.length} size="small" />
                  </Button>
                </Popover>
              )}
            </Space>
            {(info.status === "segmenting" || info.status === "running") && !showStatusOnly && (
              <Progress
                percent={info.progress}
                strokeWidth={20}
                style={{ width: 320, margin: 0 }}
                format={progressText}
              />
            )}
            <Space wrap>
              <Button
                size="small"
                style={allLoadedSelected ? inkBtnStyleActive : inkBtnStyle}
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (allLoadedSelected) {
                      for (const key of loadedKeys) next.delete(key);
                    } else {
                      for (const key of loadedKeys) next.add(key);
                    }
                    return next;
                  })
                }
              >
                {allLoadedSelected ? tr("act.deselectAll") : tr("act.selectAll")}
              </Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={savingAll}
                disabled={dirtyCount === 0} onClick={() => { void saveAll(); }}>{tr("detail.saveChanges")}</Button>
              <MenuButton
                label={tr("detail.resegment")}
                icon={<SplitCellsOutlined />}
                loading={preparing}
                type="default"
                style={inkBtnStyle}
                items={[
                  { key: "all", label: tr("detail.textAll") },
                  { key: "selected", label: tr("detail.textSelected"), disabled: selected.size === 0 },
                ]}
                onSelect={() => void startPrepare()}
              />
              <MenuButton
                label={tr("detail.phonetic")}
                icon={<SoundOutlined />}
                loading={phoneticLoading}
                items={[
                  { key: "all", label: tr("detail.textAll") },
                  { key: "selected", label: tr("detail.textSelected"), disabled: selected.size === 0 },
                ]}
                onSelect={(key) => void startPhonetic(key === "selected" ? "selected" : "all")}
                disabled={Boolean(phoneticDisabledReason)}
                tooltip={phoneticDisabledReason}
                type="default"
                style={inkBtnStyle}
              />
              {ttsButton}
              <Checkbox
                checked={skipExisting}
                onChange={(e) => setSkipExisting(e.target.checked)}
                disabled={skipTts || info?.status === "segmenting" || info?.status === "running"}
              >
                {tr("detail.skipExisting")}
              </Checkbox>
              <MenuButton
                label={tr("detail.export")}
                icon={<DownloadOutlined />}
                type="default"
                style={inkBtnStyle}
                loading={exporting}
                items={[
                  { key: "chapters-mp3", label: tr("detail.exportChaptersMp3") },
                  { key: "chapters-wav", label: tr("detail.exportChaptersWav") },
                  { key: "chapters-zip", label: tr("detail.exportChaptersZip") },
                  ...(selected.size > 0
                    ? [
                        { key: "selected-mp3", label: tr("detail.exportSelectedMp3", { count: selected.size }) },
                        { key: "selected-wav", label: tr("detail.exportSelectedWav", { count: selected.size }) },
                        { key: "selected-zip", label: tr("detail.exportSelectedZip", { count: selected.size }) },
                      ]
                    : []),
                ]}
                onSelect={(key) => void doExport(key)}
              />
              <Dropdown
                menu={{
                  items: [
                    { key: "unused", label: tr("pref.retentionModeUnused") },
                    { key: "all", label: tr("pref.retentionModeAll"), danger: true },
                  ],
                  onClick: ({ key }) => {
                    if (key === "all") {
                      setCleanupWord("");
                      setCleanupOpen(true);
                    } else {
                      void doCleanup("unused");
                    }
                  },
                }}
              >
                <Button danger icon={<DeleteOutlined />} style={inkBtnStyle}>
                  {tr("act.delete")}
                </Button>
              </Dropdown>
            </Space>
          </div>

          {showStatusOnly ? (
            <div className="flat-card" style={{ padding: 24, borderRadius: 12 }}>
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Typography.Text strong>
                  {info.status === "segmenting" ? tr("detail.preparing") : tr("detail.synthesizing")}
                </Typography.Text>
                <Progress percent={info.progress} strokeWidth={20} format={progressText} />
                <Typography.Text type="secondary">
                  {info.status === "segmenting" ? tr("detail.preparingHint") : tr("detail.synthesizingHint")}
                </Typography.Text>
              </Space>
            </div>
          ) : info.status === "error" && showMissingSegments ? (
            <Empty description={tr("detail.failedHint")} style={{ padding: 32 }}>
              <Space wrap>
                <Button onClick={() => void load({ resetChapters: false, clearSelection: false })}>{tr("detail.refreshStatus")}</Button>
                <Button type="primary" loading={preparing} onClick={() => void startPrepare()}>
                  <SplitCellsOutlined />
                  {tr("detail.resegment")}
                </Button>
              </Space>
            </Empty>
          ) : showMissingSegments ? (
            <Empty description={tr("detail.noSegments")} style={{ padding: 32 }}>
              <Space wrap>
                <Button onClick={() => void load({ resetChapters: false, clearSelection: false })}>{tr("detail.refreshStatus")}</Button>
                <Button type="primary" loading={preparing} onClick={() => void startPrepare()}>
                  <SplitCellsOutlined />
                  {tr("detail.resegment")}
                </Button>
              </Space>
            </Empty>
          ) : (
            <>
              <div style={{ flex: 1, minHeight: 0, display: "flex", gap: CHAPTER_PANE_GAP }}>
                {/* 左侧章节栏：EPUB 分章场景下快速跳转 */}
                <aside
                  style={{
                    flex: `0 0 ${CHAPTER_PANE_WIDTH}px`,
                    width: CHAPTER_PANE_WIDTH,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    borderRight: `1px solid ${token.colorBorderSecondary}`,
                    paddingRight: 8,
                  }}
                >
                  {/* 固定表头：不随章节列表滚动 */}
                  <div style={{ flex: "0 0 auto" }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      {tr("detail.selectedCount", { selected: selected.size, total: info?.segmentCount ?? 0 })}
                    </Typography.Text>
                    <div style={{ height: 6 }} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {tr("detail.chapters", { count: info?.sources.length ?? 0 })}
                    </Typography.Text>
                  </div>
                  {/* 仅章节列表滚动 */}
                  <div style={{ flex: 1, minHeight: 0, overflow: "auto", marginTop: 6 }}>
                    {(info?.sources ?? []).map((src) => {
                      const st = chapters[src] || EMPTY_CHAPTER;
                      const active = pinned?.source === src;
                      const chapterDone = st.items.filter((x) => x.audio).length;
                      const ratio = st.total > 0 ? chapterDone / st.total : 0;
                      return (
                        <div
                          key={src}
                          title={src}
                          onClick={() => void jumpToChapter(src)}
                          style={{
                            cursor: "pointer",
                            padding: "6px 8px",
                            borderRadius: 6,
                            marginBottom: 2,
                            fontSize: 14,
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                            background: active ? token.colorPrimaryBg : "transparent",
                            color: active ? onPrimaryBg : undefined,
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {segTitle(src, tr("detail.bodyText"))}
                          </span>
                          <span
                            style={{
                              flex: "0 0 auto",
                              // 已合成（有音频）分段数 / 总分段数；完成度越高字色越深
                              color: active ? onPrimaryBg : token.colorText,
                              opacity: 0.35 + 0.65 * ratio,
                            }}
                          >
                            {st.loading ? "…" : `${chapterDone}/${st.total || "?"}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </aside>

                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {/* 分段文本搜索：与右侧分段区左边界对齐，同时与左侧「已选」同一行 */}
                <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Popover
                    open={historyOpen && searchHistory.length > 0}
                    trigger={[]}
                    placement="bottomLeft"
                    content={
                      <div style={{ width: 360 }} onMouseDown={(e) => e.preventDefault()}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {tr("detail.searchHistory")}
                        </Typography.Text>
                        <div className="search-history-list" data-expanded={historyExpanded} style={{ marginTop: 6 }}>
                          {(historyExpanded ? searchHistory : searchHistory.slice(0, 10)).map((item) => (
                            <Tag
                              key={item.id}
                              className="search-history-item"
                              title={item.query}
                              onClick={() => {
                                applyHistory(item);
                                setHistoryOpen(false);
                              }}
                            >
                              {item.query}
                            </Tag>
                          ))}
                        </div>
                        {searchHistory.length > 10 && (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => setHistoryExpanded((v) => !v)}
                          >
                            {historyExpanded ? tr("act.collapse") : tr("detail.more", { count: searchHistory.length })}
                          </Button>
                        )}
                      </div>
                    }
                  >
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder={tr("detail.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onFocus={() => setHistoryOpen(true)}
                      onBlur={() => setHistoryOpen(false)}
                      onPressEnter={() => {
                        setHistoryOpen(false);
                        if (!searchHits.length) return;
                        setHitIndex((i) => (i + 1) % searchHits.length);
                        setHitJumpToken((n) => n + 1);
                      }}
                      style={{ width: 280 }}
                    />
                  </Popover>
                  <Select
                    value={markFilter}
                    onChange={(value) => setMarkFilter(value)}
                    style={{ width: 132 }}
                    options={[
                      { label: tr("detail.filterAll"), value: "all" },
                      { label: tr("detail.filterLike"), value: "like" },
                      { label: tr("detail.filterDislike"), value: "dislike" },
                    ]}
                  />
                  <Tooltip title={tr("detail.caseSensitive")}>
                    <Button
                      type={caseSensitive ? "primary" : "default"}
                      onClick={() => setCaseSensitive((v) => !v)}
                    >
                      Aa
                    </Button>
                  </Tooltip>
                  <Tooltip title={tr("detail.wildcard")}>
                    <Button
                      type={wildcard ? "primary" : "default"}
                      onClick={() => setWildcard((v) => !v)}
                    >
                      .*
                    </Button>
                  </Tooltip>
                  <Button
                    icon={<UpOutlined />}
                    disabled={searchHits.length === 0}
                    onClick={() => {
                      if (!searchHits.length) return;
                      // 上一个 = (cur + N - 1) % N，循环跳转
                      setHitIndex((i) => (i + searchHits.length - 1) % searchHits.length);
                      setHitJumpToken((n) => n + 1);
                    }}
                  />
                  <Button
                    icon={<DownOutlined />}
                    disabled={searchHits.length === 0}
                    onClick={() => {
                      if (!searchHits.length) return;
                      // 下一个 = (cur + 1) % N，循环跳转
                      setHitIndex((i) => (i + 1) % searchHits.length);
                      setHitJumpToken((n) => n + 1);
                    }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {searching ? tr("detail.searching") : searchHits.length ? `${hitIndex + 1} / ${searchHits.length}` : "0 / 0"}
                  </Typography.Text>
                </div>
                {pinned && !pinned.isHeader && (
                  <div
                    style={{
                      flex: "0 0 auto",
                      zIndex: 5,
                      background: token.colorPrimaryBg,
                      borderRadius: 8,
                      boxShadow: token.boxShadowTertiary,
                      marginBottom: 4,
                    }}
                  >
                    {renderChapterHeader(pinned.source, true)}
                  </div>
                )}
                <div ref={listBoxRef} style={{ flex: 1, minHeight: 0 }}>
                <VirtualList
                  ref={listRef}
                  data={rows}
                  height={listHeight}
                  // 行高估算值（见 estimatedRowHeight）：估算过小会让滚动条提前到底、
                  // 最后几行滚不出来；实际行高仍由 rc-virtual-list 测量。
                  itemHeight={estimatedRowHeight}
                  itemKey={(row) => row.key}
                  fullHeight={false}
                  onVisibleChange={handleVisibleChange}
                >
                  {(row) => {
                    if (row.kind === "header") {
                      return renderChapterHeader(row.source);
                    }
                    const isHit = currentHit?.key === row.seg.key;
                    return (
                      <div
                        style={{
                          padding: "0 2px",
                          borderRadius: 8,
                          ...(isHit
                            ? { background: token.colorWarningBg, boxShadow: `inset 0 0 0 2px ${token.colorWarningBorder}` }
                            : {}),
                        }}
                      >
                        <SegmentRow
                          taskId={taskId}
                          seg={row.seg}
                          index={row.index}
                          selected={selected.has(row.seg.key)}
                          onToggle={toggle}
                          onDraft={handleDraft}
                          onSaved={handleSegmentSaved}
                          draft={draftsRef.current.get(row.seg.key)}
                          audioRefreshToken={audioRefreshToken}
                          serverRefreshToken={serverRefreshToken}
                          onPlay={handleRowPlay}
                          playing={playing?.key === row.seg.key}
                          mark={marks[row.seg.key]}
                          onMarked={handleMarked}
                        />
                      </div>
                    );
                  }}
                </VirtualList>
                </div>
                </div>
              </div>

              <PlaybackBar
                visible={!!playing}
                label={playbackLabel}
                isPlaying={isPlaying}
                continuous={continuous}
                current={audioCurrent}
                duration={audioDuration}
                hasPrev={hasPrev}
                hasNext={hasNext}
                onTogglePlay={togglePlay}
                onPrev={() => playAdjacent(-1)}
                onNext={() => playAdjacent(1)}
                onStop={stopPlayback}
                onToggleContinuous={() => setContinuous((v) => !v)}
                onSeek={seekTo}
              />
              <audio
                ref={audioRef}
                src={playing?.url}
                hidden
                onLoadStart={() => setAudioActive(true)}
                onWaiting={() => setAudioActive(true)}
                onCanPlay={() => setAudioActive(true)}
                onPlay={() => { setIsPlaying(true); setAudioActive(true); }}
                onPlaying={() => { setIsPlaying(true); setAudioActive(true); }}
                onEnded={handleAudioEnded}
                onPause={() => { setIsPlaying(false); setAudioActive(false); }}
                onError={() => goNextOrStop()}
                onTimeUpdate={() => setAudioCurrent(audioRef.current?.currentTime ?? 0)}
                onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration || 0)}
                onDurationChange={() => setAudioDuration(audioRef.current?.duration || 0)}
              />
            </>
          )}
        </div>
      )}

      </div>

      <Modal
        open={cleanupOpen}
        title={tr("cleanup.confirmTitle")}
        okText={tr("act.delete")}
        okButtonProps={{ danger: true, disabled: cleanupWord !== "delete" }}
        cancelText={tr("act.cancel")}
        onCancel={() => setCleanupOpen(false)}
        onOk={() => {
          setCleanupOpen(false);
          void doCleanup("all");
        }}
      >
        <p>{tr("cleanup.confirmHint")}</p>
        <Input value={cleanupWord} onChange={(e) => setCleanupWord(e.target.value)} placeholder="delete" />
      </Modal>
    </div>
  );
}