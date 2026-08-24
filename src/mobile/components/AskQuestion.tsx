import React, { useState, useCallback } from "react";
import type { AskQuestionData } from "../hooks/useChatEngine";

interface AskQuestionProps {
  question: AskQuestionData;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
}

export function AskQuestion({ question, onAnswer }: AskQuestionProps) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [inputValue, setInputValue] = useState("");
  const questions = question.questions || [];

  const currentIdx = questions.findIndex((_, i) => !answers[i]);

  const submitAnswer = useCallback(
    (idx: number, value: string) => {
      const newAnswers = { ...answers, [idx]: value };
      setAnswers(newAnswers);
      setInputValue("");

      const allDone = questions.every((_, i) => newAnswers[i]);
      if (allDone) {
        const answerMap: Record<string, string> = {};
        questions.forEach((q, i) => {
          answerMap[q.question] = newAnswers[i];
        });
        onAnswer(question.id, answerMap);
      }
    },
    [answers, questions, question.id, onAnswer]
  );

  return (
    <div className="hyo-ask">
      {questions.map((q, i) => {
        const isActive = i === currentIdx;
        const isAnswered = !!answers[i];
        const isPending = !isActive && !isAnswered;

        return (
          <div
            key={i}
            className={`hyo-ask-item ${isActive ? "is-active" : ""} ${isAnswered ? "is-answered" : ""} ${isPending ? "is-pending" : ""}`}
          >
            <div className="hyo-ask-item-header">
              {q.header && <span className="hyo-ask-chip">{q.header}</span>}
              {isAnswered && (
                <span className="hyo-ask-answered-badge">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {answers[i]}
                </span>
              )}
            </div>

            <div className="hyo-ask-question-text">{q.question}</div>

            {isActive && (
              <div className="hyo-ask-controls">
                {q.options && q.options.length > 0 && (
                  <>
                    <div className="hyo-ask-options">
                      {q.options.map((opt, oi) => (
                        <button
                          key={oi}
                          className="hyo-ask-opt"
                          onClick={() => submitAnswer(i, opt.label)}
                        >
                          <span className="hyo-ask-opt-label">{opt.label}</span>
                          {opt.description && (
                            <span className="hyo-ask-opt-desc">{opt.description}</span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="hyo-ask-divider">
                      <span>or type your own</span>
                    </div>
                  </>
                )}
                <div className="hyo-ask-input">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && inputValue.trim()) {
                        submitAnswer(i, inputValue.trim());
                      }
                    }}
                    placeholder={q.options?.length ? "Other..." : "Type your answer..."}
                    autoFocus
                  />
                  <button
                    className="hyo-ask-send"
                    onClick={() => inputValue.trim() && submitAnswer(i, inputValue.trim())}
                    disabled={!inputValue.trim()}
                    aria-label="Send"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
