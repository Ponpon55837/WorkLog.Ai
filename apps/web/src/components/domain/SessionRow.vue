<script setup lang="ts">
import { computed } from "vue";
import { FileDiff } from "lucide-vue-next";
import type { WorkSessionRecord } from "@work-intelligence/core";
import { formatDate, formatReadableSummary, formatRelative } from "../../utils/format";
import { verificationOf, verificationStatus } from "../../utils/status";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiLabel from "../ui/UiLabel.vue";
import StatusLabel from "./StatusLabel.vue";

/** One Session in any list (Sessions, Dashboard, Reports). Selecting it opens the SessionPanel. */
const props = withDefaults(defineProps<{ session: WorkSessionRecord; showSummary?: boolean }>(), { showSummary: true });
const emit = defineEmits<{ open: [session: WorkSessionRecord] }>();

const verification = computed(() => verificationStatus[verificationOf(props.session)]);
const firstOutcome = computed(() => props.session.workSummary?.outcomes[0] ?? formatReadableSummary(props.session.summary).split("\n")[0]);
</script>

<template>
  <UiBoxRow clickable data-testid="session-row" @select="emit('open', session)">
    <template #leading>
      <component :is="verification.icon" :size="16" :stroke-width="1.75" :class="`tone-${verification.tone}`" :aria-label="`Verification ${verification.label}`" />
    </template>
    <template #title>{{ session.title }}</template>
    <template #meta>
      <span>{{ session.projectName }}</span>
      · <time :datetime="session.completedAt" :title="formatDate(session.completedAt)">{{ formatRelative(session.completedAt) }}</time>
      <template v-if="session.gitBranch"> · {{ session.gitBranch }}</template>
      <template v-if="showSummary && firstOutcome"> · {{ firstOutcome }}</template>
    </template>
    <template #trailing>
      <StatusLabel :status="verification" :show-icon="false" />
      <UiLabel class="hide-sm" :icon="FileDiff">{{ session.changedFiles.length }}</UiLabel>
    </template>
  </UiBoxRow>
</template>

<style scoped>
.tone-success { color: var(--success); }
.tone-danger { color: var(--danger); }
.tone-attention { color: var(--attention); }
.tone-neutral { color: var(--fg-muted); }
</style>
