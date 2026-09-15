export function SkeletonLine({ width = "100%" }: { width?: string }) {
  return <div className="skeleton skeleton-line" style={{ width }} />;
}

/** A table row of skeleton cells, matching a real <tr>'s column count. */
export function SkeletonTableRows({ columns, rows = 4 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr className="skeleton-row" key={rowIndex}>
          {Array.from({ length: columns }).map((_, colIndex) => (
            <td key={colIndex}>
              <SkeletonLine width={colIndex === 0 ? "70%" : "50%"} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SkeletonCard() {
  return (
    <div className="card">
      <SkeletonLine width="40%" />
      <div style={{ marginTop: "0.6rem" }}>
        <SkeletonLine width="60%" />
      </div>
    </div>
  );
}
