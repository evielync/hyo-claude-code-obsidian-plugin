import React, { useState, useRef, useEffect } from "react";
import type { PastSession } from "../session-parser";

interface SessionDropdownProps {
  pastSessions: PastSession[];
  onOpen: (session: PastSession) => void;
  onRefresh: () => void;
}

export function SessionDropdown({
  pastSessions,
  onOpen,
  onRefresh,
}: SessionDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const handleToggle = () => {
    if (!isOpen) onRefresh();
    setIsOpen(!isOpen);
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const d = new Date(date);
    const diffDays = Math.floor(
      (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString();
  };

  const grouped: Record<string, PastSession[]> = {};
  for (const s of pastSessions) {
    const label = formatDate(s.date);
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(s);
  }

  return (
    <div className="hyo-session-dropdown" ref={dropdownRef}>
      <button
        className="hyo-session-dropdown-toggle"
        onClick={handleToggle}
        title="Past conversations"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3l2 2" />
        </svg>
      </button>

      {isOpen && (
        <div className="hyo-session-dropdown-menu">
          <div className="hyo-session-dropdown-header">
            Past Conversations
          </div>
          {pastSessions.length === 0 ? (
            <div className="hyo-session-dropdown-empty">
              No past conversations
            </div>
          ) : (
            <div className="hyo-session-dropdown-list">
              {Object.entries(grouped).map(([label, sessions]) => (
                <div key={label}>
                  <div className="hyo-session-dropdown-date">{label}</div>
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      className="hyo-session-dropdown-item"
                      onClick={() => {
                        onOpen(session);
                        setIsOpen(false);
                      }}
                    >
                      {session.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
