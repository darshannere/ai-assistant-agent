import React, { useEffect, useState } from 'react';
import './HelpModal.css'; // We'll create this CSS file next
import { repositionTooltips } from '@uiw/react-codemirror';

function HelpModal({ isOpen, onClose, id }) {
  const [selectedOption, setSelectedOption] = useState(null);
  const backendServer='localhost'

  if (!isOpen) {
    return null; // Don't render the modal if it's not open
  }
 
  const handleOptionClick = (option) => {
    setSelectedOption(option);
  };

  const handleSubmit = () => {
    fetch(`http://${backendServer}:8000/replyToHelp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: id, choice: selectedOption, text: "" }),
    }).then(response => {
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.json();
    }
    ).then(data => {
      console.log('Help request successful: and sent', data);
    }).catch(error => {
      console.error('There was a problem with the help request:', error);
    });

    onClose(); // Close the modal after submission (optional)
  };

  return (
    <div className="modal-overlay" onClick={onClose}> {/* Close on overlay click */}
      <div className="modal-content"  style={{ backgroundColor:"#333"}}onClick={(e) => e.stopPropagation()}> {/* Prevent closing when clicking inside */}
        <h2>Looks like you are stuck! Would you like to ask for help?</h2>

        <div className="modal-body">
          <div className="suggestions-column">
            <p className="suggestions-label">Suggestions</p>
            <button
              className={`suggestion-option ${selectedOption === 'Quick Help 💡' ? 'selected' : ''}`}
              onClick={() => handleOptionClick('Quick Help 💡')}
            >
            Quick Help 💡
            </button>
            <button
              className={`suggestion-option ${selectedOption === 'I am fully stuck 🆘' ? 'selected' : ''}`}
              onClick={() => handleOptionClick('I am fully stuck 🆘')}
            >
            I am fully stuck 🆘
            </button>
            <button
              className={`suggestion-option ${selectedOption === 'No Help 🚫' ? 'selected' : ''}`}
              onClick={() => handleOptionClick('No Help 🚫')}
            >
              No Help 🚫
            </button>
          </div>

          <div className="graphs-column">
            {/* Placeholder for End Goal Completion % */}
            <div className="graph-placeholder">
                <p>End Goal Completion %</p>
                {/* Simple bar representation */}
                <div className="progress-bar-container">
                    <div className="progress-bar-completed" style={{ width: '15%' }}></div> {/* Example: 15% completed */}
                    <div className="progress-bar-prediction" style={{ width: '65%' }}></div> {/* Example: 65% predicted */}
                    <span className="progress-label">80%</span>
                </div>
                <div className="legend">
                   <span className="legend-item completed"></span> completed
                   <span className="legend-item prediction"></span> prediction
                </div>
            </div>

             {/* Placeholder for Progress Contributions */}
            <div className="graph-placeholder">
                <p>Progress Contributions in %</p>
                 {/* You would integrate a charting library here for a real graph */}
                <div className="chart-area">
                   <p style={{textAlign: 'center', color: '#aaa'}}>Graph Placeholder</p>
                </div>
                <div className="legend feline-dog">
                    <span className="legend-item feline"></span> FelineDog
                </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="submit-button" onClick={handleSubmit} disabled={!selectedOption}>
            Submit
          </button>
          {/* Optional: Add a close button */}
          {/* <button className="close-button" onClick={onClose}>Close</button> */}
        </div>
      </div>
    </div>
  );
}

export default HelpModal;