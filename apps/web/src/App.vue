<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import GraphNodeModal from "./components/GraphNodeModal.vue";
import HandoffImportModal from "./components/HandoffImportModal.vue";
import KnowledgeEditorModal from "./components/KnowledgeEditorModal.vue";
import KnowledgeHistoryModal from "./components/KnowledgeHistoryModal.vue";
import SessionDetailModal from "./components/SessionDetailModal.vue";
import { useApi } from "./composables/useApi";
import { requestAppRefresh } from "./composables/useAppRefresh";
import { useProjects } from "./composables/useProjects";
import { useToast } from "./composables/useToast";
import { errorMessage as toErrorMessage } from "./utils/format";

const navItems = [
  { name: "dashboard", icon: "⌂", label: "工作總覽", hint: "Dashboard" },
  { name: "projects", icon: "◈", label: "專案與記錄", hint: "Projects / Tracking" },
  { name: "reports", icon: "▥", label: "工作報告", hint: "Reports" },
  { name: "knowledge", icon: "✦", label: "工作知識", hint: "Knowledge" },
  { name: "graph", icon: "◎", label: "工作圖譜", hint: "Graph" },
  { name: "sessions", icon: "≡", label: "工作歷程", hint: "Worklog" }
] as const;

const route = useRoute();
const pageTitle = computed(() => route.meta.title ?? "Work Intelligence");
const { loadDashboard, loadProjects } = useProjects();
const { toastMessage, dismissToast } = useToast();
const loading = ref(true);
const errorMessage = ref("");

async function loadShared(): Promise<void> {
  errorMessage.value = "";
  try {
    await Promise.all([loadDashboard(), loadProjects()]);
  } catch (error) {
    errorMessage.value = toErrorMessage(error, "無法載入 Work Intelligence。");
  }
}

async function refresh(): Promise<void> {
  await loadShared();
  requestAppRefresh();
}

onMounted(async () => {
  await loadShared();
  loading.value = false;
});

onBeforeUnmount(() => {
  useApi().abortAll();
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">WI</div>
        <div>
          <div class="brand-name">Work Intelligence</div>
          <div class="brand-subtitle">Local-first work memory</div>
        </div>
      </div>

      <nav class="navigation" aria-label="主選單">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name }"
          :data-testid="`nav-${item.name}`"
          class="nav-item"
          active-class="active"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-copy"><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></span>
        </RouterLink>
      </nav>

      <div class="sidebar-note">
        <span class="pulse-dot"></span>
        <div>
          <strong>Policy gate enabled</strong>
          <p>未明確加入的專案，不讀取、不保存。</p>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div>
          <div class="eyebrow">WORK MEMORY / MVP</div>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="topbar-actions">
          <span class="local-badge"><span class="status-dot"></span>Local-first</span>
          <button class="refresh-button" type="button" aria-label="重新整理" @click="refresh">↻</button>
        </div>
      </header>

      <div v-if="errorMessage" class="alert error-alert">{{ errorMessage }}</div>
      <div v-if="toastMessage" class="toast" @click="dismissToast">{{ toastMessage }}</div>

      <section v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <p>正在載入本機工作資料…</p>
      </section>
      <RouterView v-else />
    </main>

    <HandoffImportModal />
    <GraphNodeModal />
    <SessionDetailModal />
    <KnowledgeHistoryModal />
    <KnowledgeEditorModal />
  </div>
</template>
