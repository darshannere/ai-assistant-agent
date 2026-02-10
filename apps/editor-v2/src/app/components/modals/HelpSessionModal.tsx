import React, { useState, useEffect } from 'react';
import './HelpSessionModal.css'; // We'll define this CSS file below

const HelpSessionStartedModal = ({
  isOpen,
  onClose,
  totalDurationSeconds, // Total time for the session in seconds
  taskContext,          // Description of the task
  helperName            // Name or ID of the person being helped
}) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Effect to reset elapsed time if the modal is reopened for a new session
  // (e.g. if props like totalDurationSeconds change while it was closed)
  useEffect(() => {
    if (isOpen) {
      setElapsedSeconds(0);
    }
  }, [isOpen, totalDurationSeconds, taskContext, helperName]);

  // Effect for the timer logic
  useEffect(() => {
    let timerId;
    if (isOpen && elapsedSeconds < totalDurationSeconds) {
      timerId = setInterval(() => {
        setElapsedSeconds((prevSeconds) => prevSeconds + 1);
      }, 1000);
    } else if (elapsedSeconds >= totalDurationSeconds && isOpen) {
      // Optional: Auto-close or perform an action when time is up
      // console.log("Session time complete.");
    }

    // Cleanup function to clear the interval
    return () => {
      clearInterval(timerId);
    };
  }, [isOpen, elapsedSeconds, totalDurationSeconds]);

  const formatTime = (timeInSeconds) => {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = timeInSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  if (!isOpen) {
    return null;
  }

  const isTimeUp = elapsedSeconds >= totalDurationSeconds;

  return (
    <div className="modal-overlay">
      <div className="modal-content help-session-modal">
        <h2>Help Session in Progress</h2>
        
        <div className="section">
          <p><strong>Helping:</strong> {helperName || 'Teammate'}</p>
          <p><strong>Task:</strong> {taskContext || 'Assisting with a task.'}</p>
        </div>
        
        <div className="section timer-section">
          <h3 style={{color: "#eee",}}>Time Elapsed</h3>
          <p className="timer-display">
            {formatTime(elapsedSeconds)} / {formatTime(totalDurationSeconds)}
          </p>
          {isTimeUp && <p className="time-up-message">Session time has concluded!</p>}
        </div>
        
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            {isTimeUp ? 'Close' : 'End Session Early'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HelpSessionStartedModal;