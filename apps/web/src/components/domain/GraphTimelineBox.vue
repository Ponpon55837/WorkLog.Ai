<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { CalendarRange, FolderGit2, Maximize2, ZoomIn, ZoomOut } from "lucide-vue-next";
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
import {
  DAY_MS,
  DETAIL_MIN_DAY_WIDTH,
  axisTicks,
  dayBuckets,
  packRows,
  smallestFitting,
  visibleSpans,
  type DayBucket,
  type PackedSpan,
} from "../../utils/timeline-layout";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmentedControl from "../ui/UiSegmentedControl.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

type TimelineView = "chart" | "list";
/**
 * start/end are the drawn extent used for row packing: at least MIN_MARK_PX wide at the current zoom, so points
 * and very short Sessions never overlap. `startTime`/`completedTime` are the recorded times.
 */
type SessionBar = TimelineSession & { start: number; end: number; startTime: number; completedTime: number };
/**
 * A project lane. Zoomed in it holds single Sessions packed into rows; zoomed out it holds one column per day
 * (`buckets`), so a busy project never turns into dozens of rows.
 */
interface Lane {
  id: string;
  name: string;
  top: number;
  height: number;
  bars: PackedSpan<SessionBar>[];
  buckets: DayBucket[];
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

const DAY = DAY_MS;
/** Pixels per day: from a whole year on screen to a few hours. */
const MIN_DAY_WIDTH = 0.5;
const MAX_DAY_WIDTH = 960;
const laneHeader = 26;
/** Height of the day columns in the zoomed-out view. */
const columnHeight = 64;
const markerRow = 18;
const rowHeight = 22;
const barHeight = 14;
const axisHeight = 28;
const overscanPx = 200;
const MIN_MARK_PX = 14;
/** Day columns stop growing past this width so a wide zoom still reads as a bar chart. */
const MAX_COLUMN_PX = 28;
/** Single Sessions are drawn only while every lane fits in this many rows; denser zooms stay as day columns. */
const MAX_DETAIL_ROWS = 10;
/** Zoom levels tried when looking for the first one where single Sessions fit. */
const DETAIL_WIDTHS = [DETAIL_MIN_DAY_WIDTH, 96, 192, 384, 768, MAX_DAY_WIDTH];
const rangeOptions: { value: TimelineRange; label: string }[] = [
  { value: "7", label: t("graph.last7Days") },
  { value: "30", label: t("graph.last30Days") },
  { value: "90", label: t("graph.last90Days") },
  { value: "365", label: t("graph.lastYear") },
];
const viewOptions: { value: TimelineView; label: string }[] = [
  { value: "chart", label: t("common.diagram") },
  { value: "list", label: t("common.list") },
];
const eventLabels: Record<TimelineKnowledgeEventKind, string> = {
  created: t("graph.knowledgeCreated"),
  confirmed: t("graph.knowledgeConfirmed"),
  contradicted: t("graph.knowledgeContradicted"),
  superseded: t("graph.knowledgeSuperseded"),
};

const timelineStore = useTimelineStore();
const { range, timeline, timelineLoading, timelineError } = storeToRefs(timelineStore);
const sessionsStore = useSessionsStore();
const narrow = useMediaQuery("(max-width: 639px)");

const viewport = ref<HTMLElement | null>(null);
const chosenView = ref<TimelineView>("chart");
const dayWidth = ref(24);
const scrollLeft = ref(0);
const viewportWidth = ref(900);
const autoFit = ref(true);
const chart = ref<SVGSVGElement | null>(null);
let resizeObserver: ResizeObserver | undefined;
/** A time to center once the chart has been laid out at a new zoom. */
let pendingAnchor: number | undefined;

const view = computed<TimelineView>(() => (narrow.value ? "list" : chosenView.value));
const projectOptions = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...props.projects.map((project) => ({ value: project.id, label: project.name })),
]);
const rangeStart = computed(() => (timeline.value ? Date.parse(`${timeline.value.from}T00:00:00`) : 0));
const rangeEnd = computed(() => (timeline.value ? Date.parse(`${timeline.value.to}T00:00:00`) + DAY : 0));
const rangeDays = computed(() => Math.max(1, Math.round((rangeEnd.value - rangeStart.value) / DAY)));
/** The zoom that shows the whole range at once. */
const fitDayWidth = computed(() => clampDayWidth(viewportWidth.value / rangeDays.value));
/** Sessions grouped by project lane, built once per timeline response. */
const sessionsByProject = computed(() => {
  const groups = new Map<string, TimelineSession[]>();
  for (const session of timeline.value?.sessions ?? []) {
    const group = groups.get(session.projectId);
    if (group) group.push(session);
    else groups.set(session.projectId, [session]);
  }
  return groups;
});
/**
 * The smallest zoom where every lane's Sessions fit in MAX_DETAIL_ROWS rows. Marks narrow as the zoom grows, so
 * row counts only fall and a binary search over DETAIL_WIDTHS finds it with a few packings per response.
 */
const detailMinWidth = computed(() => {
  const groups = [...sessionsByProject.value.values()];
  return smallestFitting(DETAIL_WIDTHS, (width) =>
    groups.every((sessions) => packRows(sessionBars(sessions, width), gapAt(width)).rows <= MAX_DETAIL_ROWS),
  );
});
const detailed = computed(() => dayWidth.value >= detailMinWidth.value);
const columnWidth = computed(() => Math.min(Math.max(dayWidth.value - 2, 1.5), MAX_COLUMN_PX));
/** Centers a column in its day. */
const columnInset = computed(() => (dayWidth.value - columnWidth.value) / 2);
/** MIN_MARK_PX expressed as time at the current zoom. */
const minMarkSpan = computed(() => markSpanAt(dayWidth.value));
const chartWidth = computed(() =>
  Math.max(viewportWidth.value, ((rangeEnd.value - rangeStart.value) / DAY) * dayWidth.value),
);
const lanes = computed<Lane[]>(() => {
  const current = timeline.value;
  if (!current) return [];
  let top = axisHeight;
  return current.projects
    .map((project) => {
      const projectSessions = sessionsByProject.value.get(project.id) ?? [];
      const events = current.knowledgeEvents.filter((event) => event.projectId === project.id);
      if (!detailed.value) {
        return { project, bars: [], rows: 0, buckets: dayBuckets(projectSessions), events };
      }
      const packed = packRows(sessionBars(projectSessions, dayWidth.value), gapAt(dayWidth.value));
      return { project, bars: packed.items, rows: packed.rows, buckets: [], events };
    })
    .filter(({ bars, buckets, events }) => bars.length > 0 || buckets.length > 0 || events.length > 0)
    .map(({ project, bars, rows, buckets, events }) => {
      const body = detailed.value ? Math.max(rows, 1) * rowHeight : columnHeight;
      const height = laneHeader + markerRow + body + 8;
      const lane: Lane = {
        id: project.id,
        name: project.name,
        top,
        height,
        bars,
        buckets,
        events,
        longest: bars.reduce((max, bar) => Math.max(max, bar.end - bar.start), 0),
      };
      top += height;
      return lane;
    });
});
/** The busiest day across lanes sets the column scale, so lanes compare at a glance. */
const busiestDay = computed(() =>
  Math.max(1, ...lanes.value.flatMap((lane) => lane.buckets.map((bucket) => bucket.total))),
);
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
    buckets: lane.buckets.filter(
      (bucket) => bucket.day + DAY >= visibleWindow.value.from && bucket.day <= visibleWindow.value.to,
    ),
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
  (detailed.value ? (timeline.value?.links ?? []) : []).flatMap((link) => {
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
const ticks = computed(() =>
  axisTicks(rangeStart.value, rangeEnd.value, dayWidth.value).map((tick) => ({ ...tick, x: xAt(tick.time) })),
);
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

/** MIN_MARK_PX expressed as time at a zoom. */
function markSpanAt(width: number): number {
  return (MIN_MARK_PX / width) * DAY;
}

function gapAt(width: number): number {
  return markSpanAt(width) / 4;
}

/** Drawn extents for row packing: a point is centered on its completion time; a bar starts at its start time. */
function sessionBars(sessions: readonly TimelineSession[], width: number): SessionBar[] {
  const markSpan = markSpanAt(width);
  return sessions.map((session) => {
    const completedTime = Date.parse(session.completedAt);
    const startTime = Math.max(rangeStart.value, session.startedAt ? Date.parse(session.startedAt) : completedTime);
    const start = session.startedAt ? startTime : completedTime - markSpan / 2;
    const end = Math.max(completedTime, start + markSpan);
    return { ...session, start, end, startTime, completedTime };
  });
}

function clampDayWidth(width: number): number {
  return Math.min(Math.max(width, MIN_DAY_WIDTH), MAX_DAY_WIDTH);
}

/** Stacked segments of a day column, bottom to top: passed, other, in progress, failed. */
function columnSegments(lane: Lane, bucket: DayBucket): Array<{ key: string; y: number; height: number }> {
  const bottom = lane.top + laneHeader + markerRow + columnHeight;
  const scale = columnHeight / busiestDay.value;
  let y = bottom;
  return (
    [
      ["passed", bucket.passed],
      ["other", bucket.other],
      ["in_progress", bucket.inProgress],
      ["failed", bucket.failed],
    ] as const
  ).flatMap(([key, count]) => {
    if (count === 0) return [];
    const height = Math.max(2, count * scale);
    y -= height;
    return [{ key, y, height }];
  });
}

function bucketLabel(lane: Lane, bucket: DayBucket): string {
  const date = new Date(bucket.day);
  const parts = [
    t("graph.passed", { passed: bucket.passed }),
    t("graph.failedCount", { failed: bucket.failed }),
    t("graph.inProgressCount", { count: bucket.inProgress }),
    t("graph.other", { other: bucket.other }),
  ];
  return t("graph.sessionsZoomInToThis", {
    name: lane.name,
    month: date.getMonth() + 1,
    day: date.getDate(),
    total: bucket.total,
    breakdown: parts.join(t("common.listSeparator")),
  });
}

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
  const end = formatDate(session.completedAt);
  if (!session.startedAt) return t("graph.verification", { title: session.title, end, status });
  return t("graph.toVerification", {
    title: session.title,
    start: formatDate(session.startedAt),
    end,
    status,
  });
}

function openSession(sessionId: string): void {
  void sessionsStore.openSessionDetail(sessionId, t("graph.couldNotLoadTheSessionOnTheTimeline"));
}

function onScroll(): void {
  scrollLeft.value = viewport.value?.scrollLeft ?? 0;
}

/** Sets the zoom and keeps `anchorTime` (default: the center of the viewport) at the same place on screen. */
function zoomTo(width: number, anchorTime?: number): void {
  autoFit.value = false;
  pendingAnchor = anchorTime ?? timeAt(scrollLeft.value + viewportWidth.value / 2);
  dayWidth.value = clampDayWidth(width);
  void nextTick(applyPendingScroll);
}

/**
 * Centers `pendingAnchor` once the chart has its new width. Layout can lag the re-render by a frame or more, and a
 * scroll set before then is clamped to the old width, so the chart's ResizeObserver retries until it fits.
 */
function applyPendingScroll(): void {
  const element = viewport.value;
  if (!element || pendingAnchor === undefined) return;
  if (element.scrollWidth < Math.floor(chartWidth.value)) return;
  const maxScroll = element.scrollWidth - element.clientWidth;
  element.scrollLeft = Math.min(maxScroll, Math.max(0, xAt(pendingAnchor) - viewportWidth.value / 2));
  pendingAnchor = undefined;
  onScroll();
}

/**
 * Clicking a day column opens that day at a zoom where single Sessions are drawn, centered on the middle of that
 * lane's Sessions for the day so they are on screen even when they cluster late or early.
 */
function zoomToDay(lane: Lane, day: number): void {
  let first = Infinity;
  let last = -Infinity;
  for (const session of sessionsByProject.value.get(lane.id) ?? []) {
    const completed = Date.parse(session.completedAt);
    if (completed < day || completed >= day + DAY) continue;
    first = Math.min(first, completed);
    last = Math.max(last, completed);
  }
  const anchor = Number.isFinite(first) ? (first + last) / 2 : day + DAY / 2;
  zoomTo(Math.max(viewportWidth.value / 2, detailMinWidth.value), anchor);
}

/** Fits after the viewport is measurable; hidden/list views must not supply a zero width. */
function fitRange(): void {
  autoFit.value = true;
  const width = viewport.value?.clientWidth ?? 0;
  if (width <= 0 || !timeline.value || view.value !== "chart") return;
  viewportWidth.value = width;
  dayWidth.value = fitDayWidth.value;
  pendingAnchor = rangeEnd.value;
  void nextTick(applyPendingScroll);
}

// The graph page keeps the project filter in the URL; the store follows it.
watch(
  projectId,
  (value) => {
    timelineStore.projectId = value;
  },
  { immediate: true },
);
watch([() => timeline.value?.from, () => timeline.value?.to, projectId, view], fitRange, { flush: "post" });
// The viewport is created after loading and may reappear after an empty response.
watch(
  viewport,
  (element, previous) => {
    if (previous) resizeObserver?.unobserve(previous);
    if (element) {
      resizeObserver?.observe(element);
      fitRange();
    }
  },
  { flush: "post" },
);
// The chart mounts once the first response arrives, after the observer exists.
watch(chart, (element, previous) => {
  if (previous) resizeObserver?.unobserve(previous);
  if (element) resizeObserver?.observe(element);
});

onMounted(() => {
  timelineStore.setActive(true);
  resizeObserver = new ResizeObserver(() => {
    const width = viewport.value?.clientWidth ?? 0;
    if (width <= 0) return;
    viewportWidth.value = width;
    if (autoFit.value) fitRange();
    else applyPendingScroll();
  });
  if (viewport.value) resizeObserver.observe(viewport.value);
  if (chart.value) resizeObserver.observe(chart.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  timelineStore.setActive(false);
});
</script>

<template>
  <UiBox class="timeline" sticky-header data-testid="graph-timeline">
    <template #header>
      <UiBoxTitle :icon="CalendarRange" :title="t('graph.timeline')" :count="timeline?.sessions.length ?? 0" />
      <div class="timeline__tools">
        <UiSelect
          v-model="projectId"
          :options="projectOptions"
          :icon="FolderGit2"
          size="sm"
          :label="t('graph.chooseTimelineProjectScope')"
        />
        <UiSelect v-model="range" :options="rangeOptions" size="sm" :label="t('graph.chooseTimelinePeriod')" />
        <UiSegmentedControl
          v-if="!narrow"
          v-model="chosenView"
          :options="viewOptions"
          :label="t('graph.timelineView')"
        />
        <template v-if="view === 'chart'">
          <UiIconButton
            :icon="ZoomOut"
            :label="t('graph.zoomOutTimeline')"
            :disabled="dayWidth <= MIN_DAY_WIDTH"
            @click="zoomTo(dayWidth / 2)"
          />
          <UiIconButton
            :icon="ZoomIn"
            :label="t('graph.zoomTimeline')"
            :disabled="dayWidth >= MAX_DAY_WIDTH"
            @click="zoomTo(dayWidth * 2)"
          />
          <UiIconButton :icon="Maximize2" :label="t('graph.showWholePeriod')" @click="fitRange" />
        </template>
      </div>
    </template>

    <UiFlash v-if="timelineError" tone="danger">{{ timelineError }}</UiFlash>
    <UiFlash v-else-if="timeline?.truncated" tone="attention">{{ t("graph.thisPeriodHasMoreThan") }}</UiFlash>
    <UiSkeleton v-if="timelineLoading && !timeline" variant="card" :count="2" :label="t('graph.loadingTheTimeline')" />
    <UiEmptyState
      v-else-if="isEmpty"
      :icon="CalendarRange"
      :title="t('graph.noRecordsInThisPeriod')"
      :description="t('graph.tryAnotherPeriodOrProject')"
    />

    <template v-else-if="timeline">
      <p v-if="view === 'chart'" class="timeline__legend" aria-hidden="true">
        <span><i class="timeline__swatch timeline__swatch--passed" />{{ t("graph.verificationPassed") }}</span>
        <span><i class="timeline__swatch timeline__swatch--failed" />{{ t("graph.verificationFailed") }}</span>
        <span><i class="timeline__swatch timeline__swatch--in_progress" />{{ t("common.inProgress") }}</span>
        <span><i class="timeline__swatch timeline__swatch--other" />{{ t("graph.notRunOrNotProvided") }}</span>
        <span>{{ t("graph.knowledgeEvent") }}</span>
        <span v-if="detailed">{{ t("graph.arcsSessionLinksDashedRelated") }}</span>
        <span v-else>{{ t("graph.eachBarIsOneDay") }}</span>
      </p>
      <div
        v-show="view === 'chart'"
        ref="viewport"
        class="timeline__viewport"
        tabindex="0"
        role="region"
        :aria-label="t('graph.timelineChartScrollsHorizontallyThe')"
        @scroll.passive="onScroll"
      >
        <svg ref="chart" :width="chartWidth" :height="chartHeight" class="timeline__chart">
          <g class="timeline__axis">
            <g v-for="tick in ticks" :key="tick.time" :class="{ 'is-minor': !tick.major }">
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
              <title>
                {{
                  t("graph.knowledgeEventTooltip", {
                    kind: eventLabels[event.kind],
                    title: event.title,
                    date: formatDate(event.at),
                  })
                }}
              </title>
              <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" />
            </g>
            <g
              v-for="bucket in lane.buckets"
              :key="bucket.day"
              class="timeline__column"
              role="button"
              tabindex="0"
              :aria-label="bucketLabel(lane, bucket)"
              data-testid="timeline-day"
              @click="zoomToDay(lane, bucket.day)"
              @keydown.enter.prevent="zoomToDay(lane, bucket.day)"
              @keydown.space.prevent="zoomToDay(lane, bucket.day)"
            >
              <title>{{ bucketLabel(lane, bucket) }}</title>
              <rect
                class="timeline__column-hit"
                :x="xAt(bucket.day)"
                :y="lane.top + laneHeader + markerRow"
                :width="Math.max(dayWidth - 1, 2)"
                :height="columnHeight"
              />
              <rect
                v-for="segment in columnSegments(lane, bucket)"
                :key="segment.key"
                :class="`timeline__segment timeline__segment--${segment.key}`"
                :x="xAt(bucket.day) + columnInset"
                :y="segment.y"
                :width="columnWidth"
                :height="segment.height"
              />
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
              <th scope="col">{{ t("graph.time") }}</th>
              <th scope="col">{{ t("common.project") }}</th>
              <th scope="col">{{ t("common.kind") }}</th>
              <th scope="col">{{ t("common.body") }}</th>
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

.timeline__swatch--in_progress,
.timeline__bar--in_progress {
  color: var(--accent);
  background: var(--accent);
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

.timeline__axis .is-minor line {
  stroke-dasharray: 2 4;
}

.timeline__axis .is-minor text {
  font-size: 10px;
}

.timeline__column {
  cursor: zoom-in;
}

.timeline__column-hit {
  fill: transparent;
}

.timeline__column:hover .timeline__column-hit,
.timeline__column:focus-visible .timeline__column-hit {
  fill: var(--bg-hover);
}

.timeline__column:focus-visible {
  outline: none;
}

.timeline__segment {
  transition: opacity var(--duration-instant) ease-out;
}

.timeline__segment--passed {
  fill: var(--success);
}

.timeline__segment--failed {
  fill: var(--danger);
}

.timeline__segment--in_progress {
  fill: var(--accent);
}

.timeline__segment--other {
  fill: var(--fg-muted);
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
