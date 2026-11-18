/** 篩選 / 切換檢視時的骨架畫面 */
export default function Loading() {
  return (
    <div className="results loading" aria-busy="true" aria-label="載入中">
      <div className="skeleton skeleton-title" />
      <div className="event-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="event-card skeleton-card">
            <div className="skeleton skeleton-line short" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
        ))}
      </div>
    </div>
  );
}
