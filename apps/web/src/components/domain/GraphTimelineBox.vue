<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { CalendarRange, FolderGit2, ZoomIn, ZoomOut } from "lucide-vue-next";
import type {
  ProjectRecord,
  TimelineKnowledgeEvent,
  TimelineKnowledgeEventKind,
  TimelineSession,
} from "@work-intelligence/core";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { useSessionsStore } from "../../stores/sessions";
import { useTimelineStore, type TimelineRange } from "../../stores/timeline";
import { formatDate, formatDayGroup, formatTimeOfDay } from "../../utils/format";
import { verificationStatus } from "../../utils/status";
import { packRows, visibleSpans, type PackedSpan } from "../../utils/timeline-layout";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmentedControl from "../ui/UiSegmentedControl.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import StatusLabel from "./StatusLabel.vue";

type TimelineView = "chart" | "list";
/**
 * start/end are the drawn extent used for row packing: at least MIN_MARK_PX wide at the current zoom, so points
 * and very short Sessions never overlap. `startTime`/`completedTime` are the recorded times.
 */
type SessionBar = TimelineSession & { start: number; end: number; startTime: number; completedTime: number };
interface Lane {
  id: string;
  name: string;
  top: number;
  height: number;
  bars: PackedSpan<SessionBar>[];
  events: TimelineKnowledgeEvent[];
  longest: number;
}
interface ListEntry {
  key: string;
  at: string;
  projectName: string;
  session?: TimelineSession;
  event?: TimelineKnowledgeEvent;
}

/** The graph page's timeline: one lane per project, Sessions as bars, links as arcs, Knowledge events as marks. */
const props = defineProps<{ projects: readonly ProjectRecord[] }>();
const projectId = defineModel<string>("projectId", { required: true });

const DAY = 86_400_000;
const zoomLevels = [6, 12, 24, 48, 96, 192] as const;
const laneHeader = 26;
const markerRow = 18;
const rowHeight = 22;
const barHeight = 14;
const axisHeight = 28;
const overscanPx = 200;
const MIN_MARK_PX = 14;
const rangeOptions: { value: TimelineRange; label: string }[] = [
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
  { value: "365", label: "最近一年" },
];
const viewOptions: { value: TimelineView; label: string }[] = [
  { value: "chart", label: "圖表" },
  { value: "list", label: "清單" },
];
const eventLabels: Record<TimelineKnowledgeEventKind, string> = {
  created: "Knowledge 建立",
  confirmed: "Knowledge 被確認",
  contradicted: "Knowledge 被推翻",
  superseded: "Knowledge 被取代",
};

const timelineStore = useTimelineStore();
const { range, timeline, timelineLoading, timelineError } = storeToRefs(timelineStore);
const sessionsStore = useSessionsStore();
const narrow = useMediaQuery("(max-width: 639px)");

const viewport = ref<HTMLElement | null>(null);
const chosenView = ref<TimelineView>("chart");
const zoom = ref(2);
const scrollLeft = ref(0);
const viewportWidth = ref(900);
let resizeObserver: ResizeObserver | undefined;

const view = computed<TimelineView>(() => (narrow.value ? "list" : chosenView.value));
const projectOptions = computed(() => [
  { value: "", label: "所有記錄中專案" },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const rangeStart = computed(() => (timeline.value ? Date.parse(`${timeline.value.from}T00:00:00`) : 0));
const rangeEnd = computed(() => (timeline.value ? Date.parse(`${timeline.value.to}T00:00:00`) + DAY : 0));
const dayWidth = computed(() => zoomLevels[zoom.value]!);
/** MIN_MARK_PX expressed as time at the current zoom. */
const minMarkSpan = computed(() => (MIN_MARK_PX / dayWidth.value) * DAY);
const chartWidth = computed(() =>
  Math.max(viewportWidth.value, ((rangeEnd.value - rangeStart.value) / DAY) * dayWidth.value),
);
const lanes = computed<Lane[]>(() => {
  const current = timeline.value;
  if (!current) return [];
  let top = axisHeight;
  return current.projects
    .map((project) => {
      const sessions = current.sessions
        .filter((session) => session.projectId === project.id)
        .map((session): SessionBar => {
          const completedTime = Date.parse(session.completedAt);
          const startTime = Math.max(
            rangeStart.value,
            session.startedAt ? Date.parse(session.startedAt) : completedTime,
          );
          // A point is centered on its completion time; a bar starts at its start time.
          const start = session.startedAt ? startTime : completedTime - minMarkSpan.value / 2;
          const end = Math.max(completedTime, start + minMarkSpan.value);
          return { ...session, start, end, startTime, completedTime };
        });
      const packed = packRows(sessions, minMarkSpan.value / 4);
      const events = current.knowledgeEvents.filter((event) => event.projectId === project.id);
      return { project, packed, events };
    })
    .filter(({ packed, events }) => packed.items.length > 0 || events.length > 0)
    .map(({ project, packed, events }) => {
      const height = laneHeader + markerRow + Math.max(packed.rows, 1) * rowHeight + 8;
      const lane: Lane = {
        id: project.id,
        name: project.name,
        top,
        height,
        bars: packed.items,
        events,
        longest: packed.items.reduce((max, bar) => Math.max(max, bar.end - bar.start), 0),
      };
      top += height;
      return lane;
    });
});
const chartHeight = computed(() => {
  const last = lanes.value.at(-1);
  return last ? last.top + last.height : axisHeight;
});
/** The time window on screen (plus overscan); only bars and marks inside it are drawn. */
const visibleWindow = computed(() => ({
  from: timeAt(scrollLeft.value - overscanPx),
  to: timeAt(scrollLeft.value + viewportWidth.value + overscanPx),
}));
const renderedLanes = computed(() =>
  lanes.value.map((lane) => ({
    ...lane,
    bars: visibleSpans(lane.bars, visibleWindow.value.from, visibleWindow.value.to, lane.longest),
    events: lane.events.filter((event) => {
      const at = Date.parse(event.at);
      return at >= visibleWindow.value.from && at <= visibleWindow.value.to;
    }),
  })),
);
const barPositions = computed(() => {
  const positions = new Map<string, { x1: number; x2: number; y: number }>();
  for (const lane of renderedLanes.value) {
    for (const bar of lane.bars) {
      positions.set(bar.id, {
        x1: xAt(bar.startedAt ? bar.startTime : bar.completedTime),
        x2: xAt(bar.startedAt ? Math.max(bar.completedTime, bar.startTime + minMarkSpan.value / 2) : bar.completedTime),
        y: barY(lane, bar),
      });
    }
  }
  return positions;
});
const arcs = computed(() =>
  (timeline.value?.links ?? []).flatMap((link) => {
    const from = barPositions.value.get(link.relatedSessionId);
    const to = barPositions.value.get(link.sessionId);
    if (!from || !to) return [];
    const startX = from.x2;
    const endX = to.x1;
    const lift = Math.max(18, Math.abs(endX - startX) / 4);
    const midY = Math.min(from.y, to.y) - lift;
    return [
      {
        key: `${link.relatedSessionId}-${link.sessionId}`,
        relation: link.relation,
        d: `M ${startX} ${from.y} Q ${(startX + endX) / 2} ${midY} ${endX} ${to.y}`,
      },
    ];
  }),
);
const ticks = computed(() => {
  const step = dayWidth.value >= 48 ? 1 : dayWidth.value >= 24 ? 2 : dayWidth.value >= 12 ? 7 : 14;
  const items: Array<{ x: number; label: string }> = [];
  for (let at = rangeStart.value; at < rangeEnd.value; at += step * DAY) {
    const date = new Date(at);
    items.push({ x: xAt(at), label: `${date.getMonth() + 1}/${date.getDate()}` });
  }
  return items;
});
const listGroups = computed(() => {
  const current = timeline.value;
  if (!current) return [];
  const names = new Map(current.projects.map((project) => [project.id, project.name]));
  const entries: ListEntry[] = [
    ...current.sessions.map((session) => ({
      key: `session-${session.id}`,
      at: session.completedAt,
      projectName: names.get(session.projectId) ?? "",
      session,
    })),
    ...current.knowledgeEvents.map((event, index) => ({
      key: `event-${event.knowledgeId}-${event.kind}-${index}`,
      at: event.at,
      projectName: names.get(event.projectId) ?? "",
      event,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));
  const groups: Array<{ day: string; entries: ListEntry[] }> = [];
  for (const entry of entries) {
    const day = formatDayGroup(entry.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] });
    groups.at(-1)!.entries.push(entry);
  }
  return groups;
});
const isEmpty = computed(
  () =>
    Boolean(timeline.value) && timeline.value!.sessions.length === 0 && timeline.value!.knowledgeEvents.length === 0,
);

function timeAt(x: number): number {
  return rangeStart.value + (x / dayWidth.value) * DAY;
}

function xAt(time: number): number {
  return ((time - rangeStart.value) / DAY) * dayWidth.value;
}

function barY(lane: Lane, bar: PackedSpan<SessionBar>): number {
  return lane.top + laneHeader + markerRow + bar.row * rowHeight + barHeight / 2;
}

function sessionLabel(session: TimelineSession): string {
  const status = verificationStatus[session.verificationStatus].label;
  const start = session.startedAt ? `${formatDate(session.startedAt)} 至 ` : "";
  return `${session.title}，${start}${formatDate(session.completedAt)}，驗證：${status}`;
}

function openSession(sessionId: string): void {
  void sessionsStore.openSessionDetail(sessionId, "無法載入時間軸上的 Session。");
}

function onScroll(): void {
  scrollLeft.value = viewport.value?.scrollLeft ?? 0;
}

/** Zoom keeps the time at the center of the viewport in place. */
function setZoom(next: number): void {
  const element = viewport.value;
  const centerTime = timeAt(scrollLeft.value + viewportWidth.value / 2);
  zoom.value = Math.min(Math.max(next, 0), zoomLevels.length - 1);
  if (element) {
    requestAnimationFrame(() => {
      element.scrollLeft = Math.max(0, xAt(centerTime) - viewportWidth.value / 2);
      onScroll();
    });
  }
}

/** Starts zoomed so the whole range fits, scrolled to the newest day. */
function fitRange(): void {
  const days = (rangeEnd.value - rangeStart.value) / DAY;
  if (!days) return;
  // The largest zoom level that still fits the whole range.
  let fitting = 0;
  zoomLevels.forEach((width, index) => {
    if (width * days <= viewportWidth.value) fitting = index;
  });
  zoom.value = fitting;
  requestAnimationFrame(() => {
    if (viewport.value) {
      viewport.value.scrollLeft = viewport.value.scrollWidth;
      onScroll();
    }
  });
}

// The graph page keeps the project filter in the URL; the store follows it.
watch(
  projectId,
  (value) => {
    timelineStore.projectId = value;
  },
  { immediate: true },
);
watch(() => timeline.value?.from, fitRange);

onMounted(() => {
  timelineStore.setActive(true);
  resizeObserver = new ResizeObserver(() => {
    viewportWidth.value = viewport.value?.clientWidth ?? viewportWidth.value;
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  timelineStore.setActive(false);
});
</script>

<template>
  <UiBox class="timeline" sticky-header data-testid="graph-timeline">
    <template #header>
      <UiBoxTitle :icon="CalendarRange" title="時間軸" :count="timeline?.sessions.length ?? 0" />
      <div class="timeline__tools">
        <UiSelect
          v-model="projectId"
          :options="projectOptions"
          :icon="FolderGit2"
          size="sm"
          label="選擇時間軸專案範圍"
        />
        <UiSelect v-model="range" :options="rangeOptions" size="sm" label="選擇時間軸期間" />
        <UiSegmentedControl v-if="!narrow" v-model="chosenView" :options="viewOptions" label="時間軸檢視方式" />
        <template v-if="view === 'chart'">
          <UiIconButton :icon="ZoomOut" label="縮小時間軸" :disabled="zoom === 0" @click="setZoom(zoom - 1)" />
          <UiIconButton
            :icon="ZoomIn"
            label="放大時間軸"
            :disabled="zoom === zoomLevels.length - 1"
            @click="setZoom(zoom + 1)"
          />
        </template>
      </div>
    </template>

    <UiFlash v-if="timelineError" tone="danger">{{ timelineError }}</UiFlash>
    <UiFlash v-else-if="timeline?.truncated" tone="attention"
      >這段期間的 Session 超過 2,000 筆，只顯示最新的部分；請縮小期間或選擇單一專案。</UiFlash
    >
    <UiSkeleton v-if="timelineLoading && !timeline" variant="card" :count="2" />
    <UiEmptyState
      v-else-if="isEmpty"
      :icon="CalendarRange"
      title="這段期間沒有紀錄"
      description="換一個期間或專案；Session 完成後會出現在時間軸上。"
    />

    <template v-else-if="timeline">
      <p v-if="view === 'chart'" class="timeline__legend" aria-hidden="true">
        <span><i class="timeline__swatch timeline__swatch--passed" />驗證通過</span>
        <span><i class="timeline__swatch timeline__swatch--failed" />驗證失敗</span>
        <span><i class="timeline__swatch timeline__swatch--other" />未執行或未提供</span>
        <span>◆ Knowledge 事件</span>
        <span>弧線＝Session 關聯（虛線為一般相關）</span>
      </p>
      <div
        v-show="view === 'chart'"
        ref="viewport"
        class="timeline__viewport"
        tabindex="0"
        role="region"
        aria-label="時間軸圖表，可左右捲動；同樣的內容可切換成清單檢視"
        @scroll.passive="onScroll"
      >
        <svg :width="chartWidth" :height="chartHeight" class="timeline__chart">
          <g class="timeline__axis">
            <g v-for="tick in ticks" :key="tick.x">
              <line :x1="tick.x" :x2="tick.x" :y1="axisHeight - 6" :y2="chartHeight" />
              <text :x="tick.x + 4" :y="axisHeight - 10">{{ tick.label }}</text>
            </g>
          </g>
          <g v-for="lane in renderedLanes" :key="lane.id">
            <rect class="timeline__lane" x="0" :y="lane.top" :width="chartWidth" :height="lane.height" />
            <text class="timeline__lane-name" :x="scrollLeft + 8" :y="lane.top + 17">{{ lane.name }}</text>
            <g
              v-for="event in lane.events"
              :key="`${event.knowledgeId}-${event.kind}-${event.at}`"
              :class="`timeline__marker timeline__marker--${event.kind}`"
              :transform="`translate(${xAt(Date.parse(event.at))} ${lane.top + laneHeader + markerRow / 2 - 2})`"
            >
              <title>{{ eventLabels[event.kind] }}：{{ event.title }}（{{ formatDate(event.at) }}）</title>
              <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" />
            </g>
            <g
              v-for="bar in lane.bars"
              :key="bar.id"
              :class="`timeline__bar timeline__bar--${bar.verificationStatus}`"
              role="button"
              tabindex="0"
              :aria-label="sessionLabel(bar)"
              data-testid="timeline-bar"
              @click="openSession(bar.id)"
              @keydown.enter.prevent="openSession(bar.id)"
              @keydown.space.prevent="openSession(bar.id)"
            >
              <title>{{ sessionLabel(bar) }}</title>
              <rect
                v-if="bar.startedAt"
                :x="xAt(bar.startTime)"
                :y="barY(lane, bar) - barHeight / 2"
                :width="Math.max(xAt(bar.completedTime) - xAt(bar.startTime), 6)"
                :height="barHeight"
                rx="3"
              />
              <circle v-else :cx="xAt(bar.completedTime)" :cy="barY(lane, bar)" :r="barHeight / 2 - 1" />
            </g>
          </g>
          <path
            v-for="arc in arcs"
            :key="arc.key"
            :class="['timeline__arc', { 'timeline__arc--related': arc.relation === 'related' }]"
            :d="arc.d"
          />
        </svg>
      </div>

      <div v-if="view === 'list'" class="timeline__list" data-testid="timeline-list">
        <table v-for="group in listGroups" :key="group.day" class="timeline__table">
          <caption>
            {{
              group.day
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">時間</th>
              <th scope="col">專案</th>
              <th scope="col">類型</th>
              <th scope="col">內容</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in group.entries" :key="entry.key">
              <td>
                <time :datetime="entry.at" :title="formatDate(entry.at)">{{ formatTimeOfDay(entry.at) }}</time>
              </td>
              <td>{{ entry.projectName }}</td>
              <td>{{ entry.session ? "Session" : eventLabels[entry.event!.kind] }}</td>
              <td>
                <template v-if="entry.session">
                  <button type="button" class="timeline__link" @click="openSession(entry.session.id)">
                    {{ entry.session.title }}
                  </button>
                  <StatusLabel :status="verificationStatus[entry.session.verificationStatus]" :show-icon="false" />
                </template>
                <template v-else>{{ entry.event!.title }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </UiBox>
</template>

<style scoped>
.timeline__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.timeline__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.timeline__swatch {
  display: inline-block;
  width: 14px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
}

.timeline__swatch--passed,
.timeline__bar--passed {
  color: var(--success);
  background: var(--success);
}

.timeline__swatch--failed,
.timeline__bar--failed {
  color: var(--danger);
  background: var(--danger);
}

.timeline__swatch--other,
.timeline__bar--not_run,
.timeline__bar--not_supplied {
  color: var(--fg-muted);
  background: var(--fg-muted);
}

.timeline__bar {
  background: none;
  cursor: pointer;
}

.timeline__bar rect,
.timeline__bar circle {
  fill: currentColor;
  fill-opacity: 0.75;
}

.timeline__bar:hover rect,
.timeline__bar:hover circle,
.timeline__bar:focus-visible rect,
.timeline__bar:focus-visible circle {
  fill-opacity: 1;
  stroke: var(--fg);
  stroke-width: 1.5;
}

.timeline__bar:focus-visible {
  outline: none;
}

.timeline__viewport {
  overflow-x: auto;
  overflow-y: hidden;
}

.timeline__viewport:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.timeline__chart {
  display: block;
}

.timeline__axis line {
  stroke: var(--border-muted);
}

.timeline__axis text,
.timeline__lane-name {
  fill: var(--fg-muted);
  font-size: 11px;
}

.timeline__lane-name {
  fill: var(--fg);
  font-weight: 600;
}

.timeline__lane {
  fill: transparent;
  stroke: var(--border-muted);
}

.timeline__marker path {
  stroke: var(--bg-canvas);
  stroke-width: 1;
}

.timeline__marker--created path {
  fill: var(--done);
}

.timeline__marker--confirmed path {
  fill: var(--success);
}

.timeline__marker--contradicted path {
  fill: var(--danger);
}

.timeline__marker--superseded path {
  fill: var(--attention);
}

.timeline__arc {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.4;
  opacity: 0.8;
}

.timeline__arc--related {
  stroke-dasharray: 4 3;
}

.timeline__list {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
}

.timeline__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.timeline__table caption {
  padding-bottom: var(--space-1);
  font-weight: 600;
  text-align: start;
}

.timeline__table th,
.timeline__table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-muted);
  text-align: start;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.timeline__table th {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.timeline__link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

@media (max-width: 639px) {
  .timeline__table thead {
    display: none;
  }

  /* One compact card per row: time, project, and type on the first line, the content below. */
  .timeline__table tr {
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-muted);
    color: var(--fg-muted);
    font-size: var(--text-xs);
  }

  .timeline__table td {
    padding: 0;
    border: 0;
  }

  .timeline__table td:last-child {
    flex-basis: 100%;
    color: var(--fg);
    font-size: var(--text-sm);
  }
}
</style>
