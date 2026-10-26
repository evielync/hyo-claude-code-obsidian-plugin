import React from "react";
import { jobLine, jobInitial, type BackgroundJob } from "../background-jobs";

/**
 * One quiet line per background job, just above the composer: who's on it and
 * what it's doing right now ("Searching Gmail for Westpac"). Each line goes
 * when its job finishes; the result arrives in the chat as its own reply.
 * Shared by desktop and phone.
 */
export function BackgroundJobs({ jobs }: { jobs: BackgroundJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <div className="hyo-jobs" role="status" aria-live="polite">
      {jobs.map((job) => (
        <div key={job.id} className="hyo-job" title={job.title}>
          <span className="hyo-job-avatar" aria-hidden="true">
            {jobInitial(job)}
          </span>
          <span className="hyo-job-text">
            {/* What it's doing now first; the job's name after it, muted, is
                what gives way when the panel is narrow. */}
            <span className="hyo-job-activity">{jobLine(job)}</span>
            {job.activity && job.activity !== job.title && (
              <span className="hyo-job-title"> · {job.title}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
