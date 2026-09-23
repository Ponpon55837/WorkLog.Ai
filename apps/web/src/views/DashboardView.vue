<script setup lang="ts">
import { useRouter } from "vue-router";
import { useViewLoader } from "../composables/useAppRefresh";
import { useProjects } from "../composables/useProjects";
import { useSessionDetail } from "../composables/useSessionDetail";
import { formatDate } from "../utils/format";

const router = useRouter();
const { dashboard, recentSessions, loadDashboard } = useProjects();
const { openSessionDetail } = useSessionDetail();

useViewLoader(loadDashboard);
</script>

<template>
  <section class="page-section">
    <div class="hero-panel">
      <div>
        <div class="eyebrow warm">TODAY'S SIGNAL</div>
        <h2>把完成的工作，<br /><em>變成可搜尋的記憶。</em></h2>
        <p>Agent 完成 closing handoff 後提交 session。只有「記錄中」的專案會通過 policy gate。</p>
      </div>
      <div class="hero-orbit" aria-hidden="true">
        <div class="orbit orbit-one"></div>
        <div class="orbit orbit-two"></div>
        <div class="orbit-core">WI</div>
      </div>
    </div>

    <div class="metric-grid">
      <article class="metric-card accent-blue">
        <div class="metric-label">記錄中專案</div>
        <div class="metric-value">{{ dashboard.trackedProjects }}</div>
        <div class="metric-foot">explicit opt-in</div>
      </article>
      <article class="metric-card accent-green">
        <div class="metric-label">完成 Sessions</div>
        <div class="metric-value">{{ dashboard.finalizedSessions }}</div>
        <div class="metric-foot">不等同 Git commit</div>
      </article>
      <article class="metric-card accent-amber">
        <div class="metric-label">Recorded Events</div>
        <div class="metric-value">{{ dashboard.recordedEvents }}</div>
        <div class="metric-foot">planning → closing</div>
      </article>
    </div>

    <div class="content-grid">
      <section class="panel recent-panel">
        <div class="panel-heading">
          <div>
            <div class="eyebrow">LATEST MEMORY</div>
            <h3>最近完成的工作</h3>
          </div>
          <button class="text-button" type="button" @click="router.push({ name: 'sessions' })">查看全部 →</button>
        </div>
        <div v-if="recentSessions.length === 0" class="empty-state">
          <div class="empty-icon">∿</div>
          <strong>還沒有工作紀錄</strong>
          <p>先到 Projects / Tracking 加入一個專案，再切換為「記錄中」。</p>
        </div>
        <template v-else>
          <button v-for="session in recentSessions" :key="session.id" class="session-row" type="button" @click="openSessionDetail(session.id)">
            <div class="session-marker"></div>
            <div class="session-main">
              <strong>{{ session.title }}</strong>
              <span>{{ session.projectName }} · {{ formatDate(session.completedAt) }} · {{ session.changedFiles.length }} 個檔案</span>
            </div>
            <span class="session-arrow">↗</span>
          </button>
        </template>
      </section>

      <section class="panel policy-panel">
        <div class="panel-heading">
          <div>
            <div class="eyebrow">RECORDING POLICY</div>
            <h3>Default deny</h3>
          </div>
          <span class="shield">◇</span>
        </div>
        <p class="policy-lead">任何 handoff、Git 或 source 讀取，都必須先通過 project policy gate。</p>
        <div class="policy-flow">
          <div><span class="flow-number">01</span><span>Project discovered</span></div>
          <div class="flow-line"></div>
          <div><span class="flow-number">02</span><span>User opts in</span></div>
          <div class="flow-line"></div>
          <div><span class="flow-number">03</span><span>Agent may finalize</span></div>
        </div>
        <button class="outline-button" type="button" @click="router.push({ name: 'projects' })">管理 tracking 狀態</button>
      </section>
    </div>
  </section>
</template>
