import React from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import type { PlanReviewData } from "../hooks/useChatEngine";

interface PlanReviewProps {
  review: PlanReviewData;
  onRespond: (requestId: string, behavior: "allow" | "allow_always" | "deny") => void;
}

export function PlanReview({ review, onRespond }: PlanReviewProps) {
  const { requestId, planContent, allowedPrompts, resolved } = review;

  if (resolved) {
    return (
      <div className="hyo-plan-review hyo-plan-review-resolved">
        <div className="hyo-plan-review-status">
          {resolved === "approved" ? "✓ Plan approved" : "✗ Plan rejected"}
        </div>
      </div>
    );
  }

  return (
    <div className="hyo-plan-review">
      <div className="hyo-plan-review-header">Plan ready for review</div>

      {planContent ? (
        <div className="hyo-plan-review-content">
          <MarkdownBlock content={planContent} />
        </div>
      ) : (
        <div className="hyo-plan-review-fallback">
          Review the plan in the conversation above.
        </div>
      )}

      {allowedPrompts.length > 0 && (
        <div className="hyo-plan-review-permissions">
          <div className="hyo-plan-review-permissions-label">
            This plan needs permission to:
          </div>
          <ul>
            {allowedPrompts.map((p, i) => (
              <li key={i}>{p.prompt}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="hyo-plan-review-buttons">
        <button
          className="hyo-plan-review-reject"
          onClick={() => onRespond(requestId, "deny")}
        >
          Reject
        </button>
        <button
          className="hyo-plan-review-approve"
          onClick={() => onRespond(requestId, "allow")}
        >
          Approve plan
        </button>
      </div>
    </div>
  );
}
