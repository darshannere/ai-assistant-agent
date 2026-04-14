import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
  type Edge,
  type Connection,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './puzzleStyles.css'; 
import { BACKEND_URL, WS_URL } from '../config';
const puzzleNodeIds = [
  "Customer", "Restaurant",
  "view_menu", "create_order",  "inventory_helper", "restock_inventory",
  // "clear_order",
  // "view_order_summary", "add_to_order", "remove_from_order",
  // "calculate_order_cost", "get_receipt",
  // "cook_time_helper", "cook_order",
  // "add_to_queue", "average_cook_time"
];
import DrawModal from './modals/DrawModeal'; 

const correctLinksSet = new Set(
  [
    { source: "Customer", target: "view_menu" },
    { source: "Customer", target: "create_order" },
    // { source: "Restaurant", target: "inventory_helper" },
    // { source: "Restaurant", target: "restock_inventory" },
    // { source: "Restaurant", target: "cook_time_helper" },
    // { source: "create_order", target: "view_order_summary" },
    // { source: "create_order", target: "calculate_order_cost" },
    // { source: "create_order", target: "clear_order" },
    // { source: "create_order", target: "add_to_queue" },
    // { source: "calculate_order_cost", target: "add_to_order" },
    // { source: "calculate_order_cost", target: "remove_from_order" },
    // { source: "inventory_helper", target: "cook_order" },
    // { source: "cook_time_helper", target: "cook_order" },
    // { source: "add_to_queue", target: "cook_order" },
    // { source: "cook_time_helper", target: "average_cook_time" },
  ].map(link => `${link.source}->${link.target}`) 
);

// Helper function to generate initial positions (simple grid layout)
// const getInitialNodePositions = (nodeIds) => {
//     const nodes = [];
//     const columns = 4; // Adjust as needed
//     const xSpacing = 200;
//     const ySpacing = 100;

//     nodeIds.forEach((id, index) => {
//         nodes.push({
//         id: id,
//         // Calculate position in a grid-like manner
//         position: {
//             x: (index % columns) * xSpacing + 50, // Add some offset
//             y: Math.floor(index / columns) * ySpacing + 50, // Add some offset
//         },
//         data: { label: id },
//         // Use input/output types for clarity if desired, otherwise 'default'
//         type: 'default',
//         });
//     });
//     return nodes;
// };



const initialNodes = [
  {
    id: 'Customer',
    position: { x: 100, y: 200 }, 
    data: { label: 'Customer' },
    type: 'default', 
  },
  {
    id: 'Restaurant',
    position: { x: 500, y: 200 },
    data: { label: 'Restaurant' },
    type: 'default', 
  },
];
const initialAvailableNodes = puzzleNodeIds.filter(
  id => id !== 'Customer' && id !== 'Restaurant'
);

interface DrawProps{
  id: string;
}
export default function PuzzleApp({id}: DrawProps) {

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [correctEdges, setCorrectEdges, onCorrectEdgesChange] = useEdgesState<Edge>([]);
  const [incorrectEdges, setIncorrectEdges, onIncorrectEdgesChange] = useEdgesState<Edge>([]);
  const [modalOpen, setModalOpen] = useState(false);

  const [availableNodes, setAvailableNodes] = useState(initialAvailableNodes);
  const [tasks, setTasks] = useState<any>({
    "A": {
        "isDone": false,
    },
    "B": {
        "isDone": false,
    },
    "C": {
        "isDone": false
    }
  });
  const allEdges = useMemo(() => [...correctEdges, ...incorrectEdges], [correctEdges, incorrectEdges]);
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    console.log(id)
    if(id && !wsRef.current) {
      console.log(`Raw value from localStorage: "${id}"`);    
        const wsUrl = `${WS_URL}/ws/${id}`;
        console.log("WebSocket URL:", wsUrl);
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          console.log("WebSocket connection established");
      };
      ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          console.log("Received message:", data);
          if(data.event==='draw'){
            if (data.payload.status === 'done') {
              console.log("All users have completed the puzzle");
              setTasks(data.payload.draw_states);
              setModalOpen(true);
              ws.close();
            } else {
              console.log("Someone is remaining to complete the puzzle");
              setTasks(data.payload.draw_states);
              console.log("tastssd " )
              console.log(data.payload.draw_states);
              console.log("Tasks: ", tasks);
              Object.entries(data.payload.draw_states).forEach(([user, state]) => {
              const s = state as { isDone?: boolean };
              console.log(`User ${user} isDone: ${s.isDone}`);
              setModalOpen(true);

              });
            }}
          }
    
        ws.onclose = (event) => { 
            console.log(`WebSocket connection closed: Code=${event.code}, Reason=${event.reason}, WasClean=${event.wasClean}`);
        };

        ws.onerror = (error) => {
            console.error("WebSocket specific error event:", error);
        };

    }
  }, []);

  const addNodeToCanvas = useCallback((nodeIdToAdd: string) => {
    setAvailableNodes((prev) => prev.filter(id => id !== nodeIdToAdd));


    const newNode = {
      id: nodeIdToAdd,
  
      position: { x: Math.random() * 200 + 50, y: Math.random() * 100 + 50 }, 
      data: { label: nodeIdToAdd },
      type: 'default',
    };
    setNodes((nds) => nds.concat(newNode));
  }, [setNodes, setAvailableNodes]); 


  const onConnect = useCallback(
    (params: Connection) => {
      const connectionId = `${params.source}->${params.target}`;
      const edgeExists = correctEdges.some(edge => `${edge.source}->${edge.target}` === connectionId) ||
                         incorrectEdges.some(edge => `${edge.source}->${edge.target}` === connectionId);
      if (edgeExists) return;
      if (correctLinksSet.has(connectionId)) {
        setCorrectEdges((eds) => addEdge({ ...params, id: `${params.source}-${params.target}`, className: 'correct-edge', animated: true }, eds));
      } else {
        setIncorrectEdges((eds) => addEdge({ ...params, id: `${params.source}-${params.target}`, className: 'incorrect-edge' }, eds));
      }
    },
    [setCorrectEdges, setIncorrectEdges, correctEdges, incorrectEdges]
  );

   const handleEdgesChange = useCallback(
      (changes: EdgeChange[]) => { onCorrectEdgesChange(changes); onIncorrectEdgesChange(changes); },
      [onCorrectEdgesChange, onIncorrectEdgesChange]
   );

  const isPuzzleComplete = useMemo(() => correctEdges.length === correctLinksSet.size, [correctEdges]);
  useEffect(() => {
    const sendCompletionStatus = async () => {
      if (isPuzzleComplete) {
        console.log("Puzzle complete! Opening modal."); 
        try {
          const completedTime = 0; // Replace with actual time
          const remainingTime = 0; // Replace with actual time
          const url = `${BACKEND_URL}/DrawDone?id=${encodeURIComponent(id)}&completed_time=${completedTime}&remaining_time=${remainingTime}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ id:id,completed_time:0,remaining_time: 0 }),
          });
          if (!response.ok) {
            throw new Error('Network response was not ok');
          }
          const data = await response.json();
          console.log("Response from server:", data);   
        } catch (error) {
          console.error("Error sending completion status:", error);
        }
        // setModalOpen(true);
      }
    };

    sendCompletionStatus();
  }, [isPuzzleComplete]);
  return (
    <div className="puzzle-app-container">
       {isPuzzleComplete && (
        <div className="completion-banner">
          Puzzle Complete! Well done!
        </div>
      )}
        <h3 >Complete the following graph</h3>
        {modalOpen && (
  <div className="modal-overlay">
    <DrawModal setOpenModal={setModalOpen} />
  </div>
)}
      <div className="canvas-container" style={{ height: '500px' }}>
        
        <ReactFlow
          nodes={nodes}
          edges={allEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          fitView
        >
          <Controls />
          <MiniMap />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        </ReactFlow>
      </div>
      <div className="palette-container">
        <h3 className="palette-title">Available Nodes</h3>
        <div className="palette-nodes">
          {availableNodes.map((nodeId) => (
            <button
              key={nodeId}
              onClick={() => addNodeToCanvas(nodeId)}
              className="palette-node-button"
            >
              {nodeId}
            </button>
          ))}
          {availableNodes.length === 0 && nodes.length > 0 && (
             <p className="palette-message">All nodes added to the canvas.</p>
          )}
           {availableNodes.length === 0 && nodes.length === 0 && (
             <p className="palette-message">Click nodes to add them to the canvas above.</p>
           )}
        </div>
      </div>
    </div>
  );
}
