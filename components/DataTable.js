// Tabel data generik (porting components/table.js asli).
// columns: [{ key, label }] — sel dirender dari row[key], atau
// column.render(row) bila disediakan. Nilai React (select/input) didukung.
export default function DataTable({ columns, rows, emptyText = 'Belum ada data.' }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="table-empty">{emptyText}</td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.id ?? row.key ?? i}>
              {columns.map((col) => (
                <td key={col.key}>{col.render ? col.render(row) : row[col.key] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
