import React, { useState, useEffect } from 'react';
import './CollabModal.css'; // Assuming this file exists
import { BACKEND_URL } from '../../config';
// Removed unused import: import { Background } from '@xyflow/react'; // If not used, it can be removed. Add back if needed.

const CollaborativeOpportunityModal = ({ onClose, predictions, context, id, helpeeProfile }) => {
  // Initial mock data (base structure)
  const mockOpportunityData = {
    title: "Collaborative Opportunity!",
    task: {
      assignee: "",
      description: "needs quick help with a task", // Default description
    },
    estimatedTime: {
      min: 1,       // Default min
      max: 5,       // Default max
      defaultValue: 3, // Default slider position
      unit: "min",
    },
    projectedCompletion: {
      staticPredictionPercent: 60,
      options: [], // This will be populated by parsed predictions
    },
    buttons: {
      primary: "Move Over (Physically) and Help",
      secondary: "Do Not Help",
    },
  };

  // URL from config

  const startHelpSession = async (helper, time, hint = 'this is hint') => {
    try {
      const response = await fetch(`${BACKEND_URL}/StartHelpSession`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ helper, time, hint }),
      });

      const data = await response.json();

      if (response.ok) {
        console.log('Help session started successfully:', data);
      } else {
        console.error('Failed to start help session:', data);
      }
    } catch (error) {
      console.error('Error starting help session:', error);
    } finally {
      if (typeof onClose === 'function') {
        onClose();
      }
    }
  };

  const [opportunityData, setOpportunityData] = useState(null);
  const [allocatedTime, setAllocatedTime] = useState(mockOpportunityData.estimatedTime.defaultValue);

  useEffect(() => {
    let parsedPredictionsArray = [];

    // 1. Parse the predictions data
    //    The input 'predictions' prop is expected to be like: ['[ { ... }, { ... } ]']
    //    So, predictions[0] is the JSON string.
    if (predictions && predictions.length > 0 && typeof predictions[0] === 'string') {
      try {
        parsedPredictionsArray = JSON.parse(predictions[0]);
        // Ensure the parsed result is an array
        if (!Array.isArray(parsedPredictionsArray)) {
          console.error("Parsed predictions data is not an array:", parsedPredictionsArray);
          parsedPredictionsArray = []; // Fallback to empty array
        }
      } catch (error) {
        console.error("Failed to parse predictions JSON string:", error);
        parsedPredictionsArray = []; // Fallback to empty array on error
      }
    } else if (predictions && predictions.length > 0 && Array.isArray(predictions[0])) {
        // This case could handle if predictions prop was already an array of objects,
        // e.g., predictions = [[{...}, {...}]]
        // However, based on your sample, predictions[0] is a string.
        // If the structure is indeed [[{...}]], this part might need adjustment or clarification.
        // For now, proceeding with the assumption that predictions[0] is the JSON string.
        console.warn("Predictions prop structure might be [[...objects...]] instead of ['[...objects...]']. If so, parsing logic might need adjustment.");
    }


    // 2. Calculate newMin and newMax for the slider from parsedPredictionsArray
    let newMin = mockOpportunityData.estimatedTime.min;
    let newMax = mockOpportunityData.estimatedTime.max;

    if (parsedPredictionsArray.length > 0) {
      const disruptions = parsedPredictionsArray
        .map(p => p.individual_disruption)
        .filter(d => typeof d === 'number' && !isNaN(d));

      if (disruptions.length > 0) {
        newMin = Math.min(...disruptions);
        newMax = Math.max(...disruptions);
        // Ensure max is not less than min, can happen if only one disruption value or all are same
        if (newMax < newMin) newMax = newMin;
      }
      // If no valid disruptions, newMin/newMax remain as mockOpportunityData defaults
    }

    const currentData = {
      ...mockOpportunityData,
      task: {
        ...mockOpportunityData.task,
        description: context || mockOpportunityData.task.description,
      },
      projectedCompletion: {
        ...mockOpportunityData.projectedCompletion,
        options: parsedPredictionsArray, // Use the PARSED array of objects
      },
      estimatedTime: {
        ...mockOpportunityData.estimatedTime,
        min: newMin,
        max: newMax,
      }
    };
    setOpportunityData(currentData);

    // 3. Initialize or adjust allocatedTime to be valid based on the new min/max and available options
    let initialAllocatedTime = mockOpportunityData.estimatedTime.defaultValue;

    // Check if the default value from mock data is a valid disruption in the current predictions
    const defaultDisruptionIsValid = parsedPredictionsArray.some(
      p => typeof p.individual_disruption === 'number' && p.individual_disruption === initialAllocatedTime
    );

    let newAllocatedTime = initialAllocatedTime;

    if (defaultDisruptionIsValid && initialAllocatedTime >= newMin && initialAllocatedTime <= newMax) {
      newAllocatedTime = initialAllocatedTime;
    } else if (parsedPredictionsArray.length > 0 && typeof parsedPredictionsArray[0]?.individual_disruption === 'number') {
      // Fallback to the smallest disruption value if default isn't suitable or available
      let firstValidDisruption = parsedPredictionsArray[0].individual_disruption;
      // Ensure this fallback is also clamped within the calculated min/max
      newAllocatedTime = Math.max(newMin, Math.min(firstValidDisruption, newMax));
    } else {
      // Fallback to newMin or a clamped default if no valid prediction options
      newAllocatedTime = Math.max(newMin, Math.min(initialAllocatedTime, newMax));
    }
    setAllocatedTime(newAllocatedTime);

  }, [predictions, context]); // Dependencies for the effect. mockOpportunityData can be added if its structure could change, but it's usually constant.

  const handleSliderChange = (event) => {
    setAllocatedTime(parseInt(event.target.value, 10));
  };

  const getCurrentOption = () => {
    if (!opportunityData || !opportunityData.projectedCompletion || !Array.isArray(opportunityData.projectedCompletion.options)) {
      return null;
    }
    // Ensure allocatedTime is treated as a number for comparison
    const currentAllocatedTime = Number(allocatedTime);
    return opportunityData.projectedCompletion.options.find(
      opt => typeof opt.individual_disruption === 'number' && opt.individual_disruption === currentAllocatedTime
    ) || null;
  };

  const currentSingleOption = getCurrentOption();
  const mappedCompletedPercent = currentSingleOption ? currentSingleOption.prediction : 0;
  const currentFocusMessage = currentSingleOption ? currentSingleOption.focus : "Please adjust the time allocation.";
  const staticPredictionPercent = opportunityData?.projectedCompletion?.staticPredictionPercent || 0;

  if (!opportunityData) {
    return <div>Loading...</div>; // Handles initial render before useEffect populates opportunityData
  }

  // Destructure after opportunityData is confirmed to be non-null
  const { title, task, estimatedTime, buttons } = opportunityData;

  // Safe slider ticks generation
  const ticksCount = (typeof estimatedTime.max === 'number' && typeof estimatedTime.min === 'number' && estimatedTime.max >= estimatedTime.min)
                     ? estimatedTime.max - estimatedTime.min + 1
                     : 0;
  const sliderTicksValues = Array.from({ length: Math.max(0, ticksCount) }, (_, i) => estimatedTime.min + i);


  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>{title}</h2>
        <div className="section">
          <h3>Help Teammate</h3>
          {helpeeProfile && helpeeProfile.name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              {helpeeProfile.photo && (
                <img 
                  src={helpeeProfile.photo} 
                  alt={helpeeProfile.name}
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    border: '2px solid #ddd'
                  }}
                />
              )}
              <strong style={{ fontSize: '18px' }}>{helpeeProfile.name}</strong>
            </div>
          )}
          <p>{task.description}</p>
        </div>

        <div className="section">
          <h3>Estimated Time Allocation</h3>
          <div className="slider-container">
            <div className="slider-labels">
              <span>{typeof estimatedTime.min === 'number' ? estimatedTime.min : '-'} {estimatedTime.unit}</span>
              <span>{allocatedTime} {estimatedTime.unit}</span>
              <span>{typeof estimatedTime.max === 'number' ? estimatedTime.max : '-'} {estimatedTime.unit}</span>
            </div>
            <input
              type="range"
              min={typeof estimatedTime.min === 'number' ? estimatedTime.min : 0}
              max={typeof estimatedTime.max === 'number' ? estimatedTime.max : (estimatedTime.min > 0 ? estimatedTime.min : 100) } // Ensure max is not less than min
              value={allocatedTime}
              onChange={handleSliderChange}
              className="slider"
              step="1" // Assuming individual_disruption values are integers
            />
            <div className="slider-ticks">
              {sliderTicksValues.map((tickValue) => (
                <span key={tickValue} style={{ opacity: allocatedTime === tickValue ? 1 : 0.5 }}> {/* Example styling for current tick */}
                  {tickValue}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="section">
          <h3>Projected Completion Percent</h3>
          <p>How much of the project you will complete in remaining time</p>
          <div className="graph-container">
            <div className="graph-bar-area">
              <div className="bar-wrapper">
                <div
                  className="bar prediction-bar"
                  style={{ width: `${staticPredictionPercent}%` }}
                  title={`Static Prediction: ${staticPredictionPercent}%`}
                ></div>
                <div
                  className="bar completed-bar"
                  style={{ width: `${mappedCompletedPercent}%` }}
                  title={`Projected Task Completion: ${mappedCompletedPercent}%`}
                ></div>
                <span className="bar-value-text">{mappedCompletedPercent}%</span>
              </div>
              <div className="graph-labels-x">
                <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
              </div>
              <div className="graph-legend">
                <span className="legend-item"><span className="legend-color prediction"></span> prediction (overall)</span>
                <span className="legend-item"><span className="legend-color completed"></span> completed (this task)</span>
              </div>
            </div>
          </div>
        </div>

        <div className="section focus-message">
          <p>
            If you want to spend <strong>{allocatedTime} {estimatedTime.unit}(s)</strong> helping, focus on this: <strong>{currentFocusMessage}</strong>
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => startHelpSession(id, allocatedTime, opportunityData.task.description)}>{buttons.primary}</button>
          <button className="btn btn-secondary" onClick={onClose || (() => {})}>{buttons.secondary}</button>
        </div>
      </div>
    </div>
  );
};

export default CollaborativeOpportunityModal;