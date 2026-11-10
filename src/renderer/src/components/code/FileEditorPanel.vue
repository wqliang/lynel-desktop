<script setup lang="ts">
import { computed } from 'vue'
import CodeEditor from './CodeEditor.vue'
import CodeDiffView from './CodeDiffView.vue'
import GitPanel from './GitPanel.vue'
import { useFilesStore } from '../../stores/files'

/** 右栏右侧内容区：互斥的「编辑器 / diff / 提交历史」三个视图。
 *  全应用唯一挂载点（CodeView 内）。FileTabs 已上移到右栏顶部行
 *  （RightWorkspacePane），Monaco 同 URI 单 model 不变量由
 *  「结构上只有一个宿主」保证 —— 不得再新增第二处 FileEditorPanel 挂载。
 *  提交历史折叠进 Git 工作区后也挂在这里：它是纯 DOM 列表，不新增 Monaco /
 *  DiffEditor 实例，且用 v-show 常驻可保住 log 的展开项与滚动位置。 */
const store = useFilesStore()

/** 三者必须**恰好一个**为真 —— 用互斥的 computed 表达，而不是各自判断：
 *  一旦 activeView 取到意外值（例如热更新后 store 实例陈旧、没有 activeView 字段，
 *  `undefined === 'file'` 为假），所有 v-show 会同时隐藏，内容区整块空白
 *  （连「从左侧文件树选择文件」都不出现）。历史优先级最高：它只在 Git 视图下可开，
 *  且 openDiff() 会自动把它关掉，所以点历史里的文件能立刻回到 diff。 */
const showHistory = computed(() => store.rightView === 'git' && store.gitHistoryOpen)
const showDiff = computed(() => !showHistory.value && store.activeView === 'diff' && !!store.diffRequest)
const showEditor = computed(() => !showHistory.value && !showDiff.value)
</script>

<template>
  <section class="editor-panel">
    <!-- 用 v-show 而非 v-if：保留两个组件实例，避免 Monaco 反复重建 -->
    <div v-show="showEditor" class="editor-slot">
      <CodeEditor />
    </div>
    <div v-show="showDiff" class="editor-slot">
      <CodeDiffView />
    </div>
    <div v-show="showHistory" class="editor-slot">
      <GitPanel view="log" />
    </div>
  </section>
</template>

<style scoped>
.editor-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.editor-slot {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
