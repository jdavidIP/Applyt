import type { Application, Status } from '../types';
import { PLATFORM_LABELS, APPLY_METHOD_LABELS, formatDate } from '../labels';
import { StatusDropdown } from './StatusDropdown';

interface Props {
  applications: Application[];
  onStatusChange: (app: Application, next: Status) => void;
  onEdit: (app: Application) => void;
  onDelete: (app: Application) => void;
  busyId: number | null;
}

export function ApplicationsTable({
  applications,
  onStatusChange,
  onEdit,
  onDelete,
  busyId,
}: Props) {
  if (applications.length === 0) {
    return <p className="empty">No applications yet. Click “Add application” to create one.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="applications-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Title</th>
            <th>Platform</th>
            <th>Method</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Updated</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr
              key={app.id}
              className={app.status === 'pending_confirmation' ? 'row-pending' : undefined}
            >
              <td>
                {app.job_url ? (
                  <a href={app.job_url} target="_blank" rel="noreferrer">
                    {app.company}
                  </a>
                ) : (
                  app.company
                )}
              </td>
              <td>{app.title}</td>
              <td>{PLATFORM_LABELS[app.platform]}</td>
              <td>
                {APPLY_METHOD_LABELS[app.apply_method]}
                {app.status === 'pending_confirmation' && (
                  <span className="pending-badge" title="External redirect — confirm you completed this application">
                    needs review
                  </span>
                )}
              </td>
              <td>
                <StatusDropdown
                  value={app.status}
                  disabled={busyId === app.id}
                  onChange={(next) => onStatusChange(app, next)}
                />
              </td>
              <td>{formatDate(app.date_applied)}</td>
              <td>{formatDate(app.date_last_updated)}</td>
              <td className="row-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(app)}>
                  Edit
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => onDelete(app)}
                  disabled={busyId === app.id}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
