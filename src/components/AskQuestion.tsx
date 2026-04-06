import React, { useState, useCallback } from "react";
import type { AskQuestionData } from "../hooks/useChatEngine";

interface AskQuestionProps {
  question: AskQuestionData;
  onAnswer: (questionId: string, answer: string) => void;
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
        const answerText =
          questions.length === 1
            ? newAnswers[0]
            : questions
                .map((q, i) => `${q.question}: ${newAnswers[i]}`)
                .join("\n");
        onAnswer(question.id, answerText);
      }
    },
    [answers, questions, question.id, onAnswer]
  );

  return (
    <div className="hyo-ask-question">
      {questions.map((q, i) => (
        <div key={i} className="hyo-ask-question-item">
          {q.header && (
            <div className="hyo-ask-question-header">{q.header}</div>
          )}
          <div className="hyo-ask-question-text">{q.question}</div>

          {answers[i] ? (
            <div className="hyo-ask-question-answered">{answers[i]}</div>
          ) : i === currentIdx ? (
            <div className="hyo-ask-question-input">
              {q.options && q.options.length > 0 && (
                <div className="hyo-ask-question-options">
                  {q.options.map((opt, oi) => (
                    <button
                      key={oi}
                      className="hyo-ask-option"
                      onClick={() => submitAnswer(i, opt.label)}
                    >
                      {opt.label}
                      {opt.description && (
                        <span className="hyo-ask-option-desc">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  ))}
                  <div className="hyo-ask-or">or</div>
                </div>
              )}
              <div className="hyo-ask-text-input">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && inputValue.trim()) {
                      submitAnswer(i, inputValue.trim());
                    }
                  }}
                  placeholder="Type your answer..."
                />
                <button
                  onClick={() =>
                    inputValue.trim() && submitAnswer(i, inputValue.trim())
                  }
                  disabled={!inputValue.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
