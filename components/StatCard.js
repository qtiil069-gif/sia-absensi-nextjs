// Kartu statistik pastel (porting .stat-card di styles.css asli).
// tone: mint | peach | yellow | blue
export default function StatCard({ tone = 'mint', icon = '☺', label, value, sub }) {
  return (
    <article className={`stat-card ${tone}`}>
      <span className="stat-icon" aria-hidden="true">{icon}</span>
      <p>{label}</p>
      <strong>{value ?? '—'}</strong>
      <span>{sub || ''}</span>
    </article>
  );
}
