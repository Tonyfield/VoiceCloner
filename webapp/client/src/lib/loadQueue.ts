/**
 * 前端加载队列：对「章节分段」这类可并发的请求做优先级调度。
 *
 * - 两条泳道：`user`（用户点击/搜索命中等主动请求）与 `background`（打开任务后逐章预取）。
 * - 去重：同一 key 只跑一次；已在排队的后台任务可被提升为 user（任务重排）。
 * - 播放：`setPlaying(true)` 时收敛并发（user=1、background=0），把连接/带宽让给音频。
 * - 后台顺序：`setBackgroundOrder` 可重排预取顺序（如从当前点击章节往后加载，避免在视口上方插行）。
 */

export type LoadPriority = "user" | "background";

interface Job<T = unknown> {
  key: string;
  priority: LoadPriority;
  seq: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface Limits {
  user: number;
  background: number;
}

export class LoadQueue {
  private readonly userJobs: Job[] = [];
  private readonly backgroundJobs: Job[] = [];
  /** key → 已调度（排队中或执行中）的 Promise，用于去重。 */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** key → 排队中的任务（执行中的不在其中），用于优先级提升 / 重排。 */
  private readonly queued = new Map<string, Job>();

  private userRunning = 0;
  private backgroundRunning = 0;
  private playing = false;
  private limits: Limits;
  private backgroundOrder: string[] = [];
  private seq = 0;

  constructor(limits: Limits = { user: 3, background: 1 }) {
    this.limits = limits;
  }

  /** 播放态：收敛并发，优先保证音频。 */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.pump();
  }

  /** 重排后台预取顺序（数组越靠前越先加载）。 */
  setBackgroundOrder(order: string[]): void {
    this.backgroundOrder = order;
    this.backgroundJobs.sort((a, b) => this.compareBackground(a, b));
    this.pump();
  }

  /** 暂停/恢复后台预取（用户跳转定位期间暂停，避免在视口上方插入行）。 */
  setBackgroundPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.pump();
  }

  private paused = false;

  /**
   * 调度一次加载。相同 key 已排队/执行中时直接复用其 Promise；
   * 若新优先级更高，则把排队中的任务提升到 user 泳道（任务重排）。
   */
  schedule<T>(key: string, priority: LoadPriority, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      const job = this.queued.get(key);
      if (job && priority === "user" && job.priority === "background") {
        const index = this.backgroundJobs.indexOf(job);
        if (index >= 0) this.backgroundJobs.splice(index, 1);
        job.priority = "user";
        job.seq = this.seq++; // 重新排到 user 泳道队首
        this.userJobs.push(job);
        this.sortUser();
        this.pump();
      }
      return existing as Promise<T>;
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.inflight.set(key, promise as Promise<unknown>);

    const job: Job = {
      key,
      priority,
      seq: this.seq++,
      run: run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    this.queued.set(key, job);
    if (priority === "user") {
      this.userJobs.push(job);
      this.sortUser();
    } else {
      this.backgroundJobs.push(job);
      // 无自定义顺序时按 seq 追加本就有序，无需每次重排（避免 O(n² log n)）。
      if (this.backgroundOrder.length) {
        this.backgroundJobs.sort((a, b) => this.compareBackground(a, b));
      }
    }
    this.pump();
    return promise;
  }

  private sortUser(): void {
    // playback 不单独建泳道：user 内按 seq 先到先得。
    this.userJobs.sort((a, b) => a.seq - b.seq);
  }

  private compareBackground(a: Job, b: Job): number {
    const ra = this.rankOf(a.key);
    const rb = this.rankOf(b.key);
    if (ra !== rb) return ra - rb;
    return a.seq - b.seq;
  }

  private rankOf(key: string): number {
    if (!this.backgroundOrder.length) return Number.MAX_SAFE_INTEGER;
    const index = this.backgroundOrder.indexOf(key);
    if (index >= 0) return index;
    // 调用方可能以裸 source（不含 `chapter:` 前缀）给出顺序，这里做兼容。
    const colon = key.indexOf(":");
    if (colon < 0) return Number.MAX_SAFE_INTEGER;
    const bare = key.slice(colon + 1);
    const bareIndex = this.backgroundOrder.indexOf(bare);
    return bareIndex < 0 ? Number.MAX_SAFE_INTEGER : bareIndex;
  }

  private pump(): void {
    const userLimit = this.playing ? Math.min(1, this.limits.user) : this.limits.user;
    while (this.userRunning < userLimit && this.userJobs.length) {
      const job = this.userJobs.shift()!;
      this.queued.delete(job.key);
      this.userRunning++;
      this.runJob(job).finally(() => {
        this.userRunning--;
        this.pump();
      });
    }

    const backgroundLimit = this.playing || this.paused ? 0 : this.limits.background;
    while (this.backgroundRunning < backgroundLimit && this.backgroundJobs.length) {
      const job = this.backgroundJobs.shift()!;
      this.queued.delete(job.key);
      this.backgroundRunning++;
      this.runJob(job).finally(() => {
        this.backgroundRunning--;
        this.pump();
      });
    }
  }

  private async runJob(job: Job): Promise<void> {
    try {
      const value = await job.run();
      job.resolve(value);
    } catch (error) {
      job.reject(error);
    } finally {
      this.inflight.delete(job.key);
    }
  }
}
