import { IconSparkles, IconEdit, IconTrash } from '@tabler/icons-react';
import type { Application, Status } from '../types';
import { PLATFORM_LABELS, APPLY_METHOD_LABELS, formatDate } from '../labels';
import { StatusDropdown } from './StatusDropdown';

interface Props {
  applications: Application[];
  onStatusChange: (app: Application, next: Status) => void;
  onEdit: (app: Application) => void;
  onDelete: (app: Application) => void;
  onTailor: (app: Application) => void;
  busyId: number | null;
}

const thClass = 'px-4 py-3 border-b border-matcha-200';

export function ApplicationsTable({
  applications,
  onStatusChange,
  onEdit,
  onDelete,
  onTailor,
  busyId,
}: Props) {
  if (applications.length === 0) {
    return <p className="text-center text-ink-soft py-10">No applications yet. Click "Add application" to create one.</p>;
  }

  return (
    <div className="card overflow-hidden overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[900px]">
        <thead className="bg-matcha-50">
          <tr className="text-[11px] uppercase tracking-wider text-ink-soft font-medium">
            <th className={thClass}>Company</th>
            <th className={thClass}>Title</th>
            <th className={thClass}>Platform</th>
            <th className={thClass}>Method</th>
            <th className={thClass}>Status</th>
            <th className={thClass}>Applied</th>
            <th className={thClass}>Updated</th>
            <th className={`${thClass} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-matcha-200">
          {applications.map((app) => (
            <tr key={app.id} className="hover:bg-matcha-50/50 transition-colors">
              <td className="px-4 py-4 font-medium">
                {app.job_url ? (
                  <a
                    href={app.job_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-matcha-600 hover:underline"
                  >
                    {app.company}
                  </a>
                ) : (
                  app.company
                )}
              </td>
              <td className="px-4 py-4">{app.title}</td>
              <td className="px-4 py-4 text-ink-soft">{PLATFORM_LABELS[app.platform]}</td>
              <td className="px-4 py-4">
                {APPLY_METHOD_LABELS[app.apply_method]}
                {app.status === 'pending_confirmation' && (
                  <span
                    className="text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded ml-1.5"
                    title="External redirect — confirm you completed this application"
                  >
                    needs review
                  </span>
                )}
              </td>
              <td className="px-4 py-4">
                <StatusDropdown
                  value={app.status}
                  disabled={busyId === app.id}
                  onChange={(next) => onStatusChange(app, next)}
                />
              </td>
              <td className="px-4 py-4 text-ink-soft">{formatDate(app.date_applied)}</td>
              <td className="px-4 py-4 text-ink-soft">{formatDate(app.date_last_updated)}</td>
              <td className="px-4 py-4 text-right">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className={`btn-ghost p-1.5 flex items-center ${app.resume_version_id != null ? 'text-matcha-400' : ''}`}
                    onClick={() => onTailor(app)}
                    title={
                      app.resume_version_id != null
                        ? 'A tailored resume exists — AI-tailor again'
                        : 'AI-tailor your resume for this job'
                    }
                  >
                    <IconSparkles size={18} stroke={1.75} />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost p-1.5 flex items-center"
                    onClick={() => onEdit(app)}
                    title="Edit"
                  >
                    <IconEdit size={18} stroke={1.75} />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost p-1.5 flex items-center hover:bg-rose-100 hover:text-rose-800"
                    onClick={() => onDelete(app)}
                    disabled={busyId === app.id}
                    title="Delete"
                  >
                    <IconTrash size={18} stroke={1.75} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
