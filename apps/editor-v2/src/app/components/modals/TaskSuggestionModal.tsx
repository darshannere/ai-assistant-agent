// TaskOptionsModal.js
import React from 'react';

// Helper component for rendering individual task cards (defined within the same file)
const TaskOptionCard = ({ task }) => {
  if (!task) {
    return null;
  }

  // Convert seconds to a more readable format (e.g., minutes and seconds)
  const formatTime = (seconds) => {
    if (isNaN(seconds) || seconds < 0) {
      return 'N/A';
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0 && remainingSeconds > 0) {
      return `${minutes} min ${remainingSeconds} sec`;
    } else if (minutes > 0) {
      return `${minutes} min`;
    } else {
      return `${remainingSeconds} sec`;
    }
  };

  const cardStyle = {
    border: '1px solid #ddd',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    backgroundColor: '#f9f9f9',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  };

  const titleStyle = {
    fontSize: '1.2em',
    color: '#333',
    marginBottom: '8px',
    wordBreak: 'break-word', // Ensure long titles don't overflow
  };

  const detailStyle = {
    fontSize: '0.9em',
    color: '#555',
    marginBottom: '4px',
  };

  const reasoningStyle = {
    fontSize: '0.9em',
    color: '#666',
    marginTop: '8px',
    fontStyle: 'italic',
    whiteSpace: 'pre-wrap', // Preserve line breaks in reasoning
    wordBreak: 'break-word',
  };

  return (
    <div style={cardStyle}>
      <h3 style={titleStyle}>{task.task_title || 'Untitled Task'}</h3>
      <p style={detailStyle}>
        <strong>Prediction Score:</strong> {typeof task.prediction === 'number' ? (task.prediction * 100).toFixed(0) + '%' : 'N/A'}
      </p>
      <p style={detailStyle}>
        <strong>Estimated Time:</strong> {formatTime(task.estimated_time_in_seconds)}
      </p>
      <p style={reasoningStyle}>
        <strong>Reasoning:</strong> {task.reasoning || 'No reasoning provided.'}
      </p>
      {/* <button style={{ marginTop: '10px', padding: '8px 12px', cursor: 'pointer' }}>
        Select Task
      </button> */}
    </div>
  );
};

// Main Modal Component
const TaskOptionsModal = ({ isOpen, onClose, options }) => {
  if (!isOpen) {
    return null; // Don't render anything if the modal is not open
  }

  // Styles for the modal
  const modalOverlayStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000, // Ensure it's on top
    padding: '20px', // Add some padding for smaller screens so modal doesn't touch edges
  };

  const modalContentStyle = {
    backgroundColor: '#fff',
    padding: '20px',
    borderRadius: '8px',
    width: '100%', // Use full width up to maxWidth
    maxWidth: '600px',
    maxHeight: '90vh', // Max height to prevent overflow on small screens
    overflowY: 'auto', // Allow scrolling for content
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
    position: 'relative', // For positioning the close button
  };

  const modalHeaderStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #eee',
    paddingBottom: '10px',
    marginBottom: '20px',
  };

  const modalTitleStyle = {
    margin: 0,
    fontSize: '1.5em',
  };

  const closeButtonStyle = {
    background: 'transparent',
    border: 'none',
    fontSize: '1.5em',
    cursor: 'pointer',
    padding: '5px',
    lineHeight: '1', // Ensure 'X' is vertically centered
  };

  return (
    <div style={modalOverlayStyle} onClick={onClose}> {/* Close modal if overlay is clicked */}
      <div style={modalContentStyle} onClick={(e) => e.stopPropagation()}> {/* Prevent closing when clicking inside content */}
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>Task Options</h2>
          <button style={closeButtonStyle} onClick={onClose} aria-label="Close modal">
            &times; {/* A common 'X' icon for close */}
          </button>
        </div>
        {options && options.length > 0 ? (
          options.map((task, index) => (
            // Use the locally defined TaskOptionCard
            <TaskOptionCard key={task.task_title || index} task={task} />
          ))
        ) : (
          <p>No task options available.</p>
        )}
      </div>
    </div>
  );
};

export default TaskOptionsModal; // Export only the main modal component