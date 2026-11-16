import { TIMEZONE } from '@aeh/core';

// TODO(T10): 待審列表、單筆編輯、標籤/別名/場館快捷操作、疑似重複合併、發布/隱藏；Basic Auth 保護
export default function AdminPage() {
  return (
    <main>
      <h1>審核後台</h1>
      <p>待審佇列尚未實作（tech-spec T10）。時區：{TIMEZONE}</p>
    </main>
  );
}
