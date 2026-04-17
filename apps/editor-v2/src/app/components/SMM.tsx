import React, { useState, useEffect, useCallback, useRef } from 'react';
import  {
    ReactFlow,
    useNodesState,
    useEdgesState,
    MiniMap,
    Controls,
    Background,
    Panel, // Use Panel for UI elements overlaying the graph
    MarkerType,
    useReactFlow,
    NodeToolbar,
    Position,
    ReactFlowProvider
} from '@xyflow/react';
// import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import './SMM.css'; 
import { Node, Edge } from '@xyflow/react';
// Assuming jumpToFunction is imported from its location
// import { jumpToFunction } from "./main";

// --- Mock jumpToFunction for standalone example ---
const jumpToFunction = (nodeId) => {
    console.log(`Jumping to function/definition for: ${nodeId}`);
    // Implement your actual navigation logic here
};


import { BACKEND_URL, WS_URL } from '../config';
import ParticipantLabel from './ParticipantLabel';


// --- Dagre Layout Setup ---
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));
const nodeWidth = 180; // Adjust as needed
const nodeHeight = 40; // Adjust as needed

const getLayoutedElements = (nodes, edges, direction = 'TB') => {
    dagreGraph.setGraph({ rankdir: direction, nodesep: 50, ranksep: 70 }); // Adjust spacing

    nodes.forEach((node) => {
        dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
    });

    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        node.targetPosition = 'top'; 
        node.sourcePosition = 'bottom'; 

        // Calculate the node position (centering it)
        node.position = {
            x: nodeWithPosition.x - nodeWidth / 2,
            y: nodeWithPosition.y - nodeHeight / 2,
        };

        return node;
    });

    return { nodes: layoutedNodes, edges };
};

// --- Initial Graph Data ---
const initialNodeIds = [
"Customer", "Restaurant",
  "view_menu", "create_order",  "inventory_helper", "restock_inventory",
  "clear_order",
  "view_order_summary", "add_to_order", "remove_from_order",
  "calculate_order_cost", "get_receipt",
  "cook_time_helper", "cook_order",
  "add_to_queue", "average_cook_time"
];

const initialLinks = [
    { source: "Customer", target: "view_menu" },
    { source: "Customer", target: "create_order" },
    { source: "Restaurant", target: "inventory_helper" },
    { source: "Restaurant", target: "restock_inventory" },
    { source: "Restaurant", target: "cook_time_helper" },
    { source: "create_order", target: "view_order_summary" },
    { source: "create_order", target: "calculate_order_cost" },
    { source: "create_order", target: "clear_order" },
    { source: "create_order", target: "add_to_queue" },
    { source: "view_order_summary", target: "get_receipt" },
    { source: "calculate_order_cost", target: "add_to_order" },
    { source: "calculate_order_cost", target: "remove_from_order" },
    { source: "inventory_helper", target: "cook_order" },
    { source: "cook_time_helper", target: "cook_order" },
    { source: "add_to_queue", target: "cook_order" },
    { source: "cook_time_helper", target: "average_cook_time" },
];


// --- React Component ---
interface GraphComponentProps {
    onNodeSelect?: (nodeId: string) => void;
}

const GraphComponent = ({ onNodeSelect }: GraphComponentProps) => {
    const reactFlowInstance = useReactFlow();
    const [nodes, setNodes, onNodesChange] = useNodesState<Node[]>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge[]>([]);
    const ws = useRef<WebSocket | null>(null); 
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    
    const [participantStates, setParticipantStates] = useState<Record<string, { status: string; name: string; photo?: string; currentTasks?: string[] }>>({});
    const [participantHoverId, setParticipantHoverId] = useState<string | null>(null);
    const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});

    // Read participant ID fresh on each render
    const animalId = localStorage.getItem("participant-id") || "D";
    const storedUserId = animalId.replace(/"/g, '');

    useEffect(() => {
        const initialNodes = initialNodeIds.map(id => ({
            id: id,
            data: { label: id },
            position: { x: 0, y: 0 },
            className: 'unchecked',
            hidden: false,
            style: { width: nodeWidth, height: nodeHeight, textAlign: 'center', display: 'flex', justifyContent: 'center', alignItems: 'center' }, // Basic styling
        }));

        const initialEdges = initialLinks.map((link, i) => ({
            id: `e${i}-${link.source}-${link.target}`,
            source: link.source,
            target: link.target,
            hidden: false,
            markerEnd: {
                type: MarkerType.ArrowClosed,
            },
            // type: 'smoothstep', // Optional: Use smoothstep edges
            // style: { strokeWidth: 2 }, // Optional: Style edges
        }));
        console.log("Initial nodes and edges:", initialNodes, initialEdges);

        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
            initialNodes,
            initialEdges,
            'TB' // Layout direction: Top to Bottom
        );

        setNodes(layoutedNodes);
        setEdges(layoutedEdges);

        console.log("Layout calculated:", layoutedNodes, layoutedEdges);

    }, []);

    // Fetch initial participant states on mount
    useEffect(() => {
        fetch(`${BACKEND_URL}/debug/states`)
            .then((r) => r.json())
            .then((data) => setParticipantStates(data.participantStates || {}))
            .catch((e) => console.warn("Failed to fetch participant states:", e));
    }, []);


    useEffect(() => {
        if (!ws.current || ws.current.readyState === WebSocket.CLOSED) {
            const wsUrl = `${WS_URL}/ws/${storedUserId}`;
            console.log(`Attempting to connect WebSocket: ${wsUrl}`);
            ws.current = new WebSocket(wsUrl);

            ws.current.onopen = () => {
                console.log("WebSocket Connected");
                // Optional: Send a message on connect if needed
                // ws.current.send(JSON.stringify({ event: "clientConnected", id: animalId }));
            };

            ws.current.onerror = (error) => {
                console.error("WebSocket Error:", error);
            };

            ws.current.onclose = (event) => {
                console.log("WebSocket Disconnected:", event.reason, `Code: ${event.code}`);
                // Optional: Implement reconnection logic here if desired
            };

            ws.current.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    console.debug("WebSocket Message Received:", data); 

                    if (data.event === 'typing') {
                        const { id: tid, editor } = data.payload;
                        setTypingUsers(prev => ({ ...prev, [tid]: editor }));
                    }
                    if (data.event === 'stoppedTyping') {
                        const { id: tid } = data.payload;
                        setTypingUsers(prev => { const next = { ...prev }; delete next[tid]; return next; });
                    }

                    if (data.event === 'updateGraph' && data.payload && data.payload.graph) {
                        const graphStatus = data.payload.graph;
                        const states = data.payload.participantStates || {};
                        console.log("Received graph update:", graphStatus, "participantStates:", states);
                        setParticipantStates(states);

                        setNodes((currentNodes) =>
                            currentNodes.map((node) => {
                                const status = graphStatus[node.id];
                                let newClassName = 'unchecked';
                                if (status === 1) {
                                    newClassName = 'checked1';
                                } else if (status === 2) {
                                    newClassName = 'checked2';
                                }

                                if (node.className !== newClassName) {
                                    return {
                                        ...node,
                                        className: newClassName,
                                        data: { ...node.data },
                                        style: { ...node.style }
                                    };
                                }
                                return node;
                            })
                        );
                    }

                } catch (e) {
                    console.error("Failed to parse WebSocket message or update state:", e, "Raw data:", event.data);
                }
            };
        }

        // --- Cleanup Function ---
        // This function is returned by useEffect and runs when the component unmounts
        return () => {
            if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                console.log("Closing WebSocket connection on component unmount");
                ws.current.close();
            }
            // Set ref to null after closing if you have reconnect logic outside this effect
             // ws.current = null;
        };
        // Add dependencies carefully. If storedUserId can change, add it here.
    }, [storedUserId, setNodes]); // Re-run effect if storedUserId changes


    const onNodeClick = useCallback((event, node) => {
        console.log(`Node clicked: ${node.id}`, node);
        jumpToFunction(node.id); // Call your navigation function

        // Notify parent component about the selected node
        if (onNodeSelect) {
            onNodeSelect(node.id);
        }

        // Send update via WebSocket
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            const message = {
                event: "updateNode",
                payload: { node: node.id, id: storedUserId }
            };
            console.log("Sending WebSocket message:", message);
            ws.current.send(JSON.stringify(message));
        } else {
            console.error("WebSocket not open. Cannot send updateNode message.");
        }
    }, [storedUserId, onNodeSelect]);


    // --- Tooltip / Mouse Hover Handling (Basic Example) ---
    const onNodeMouseEnter = useCallback(async (event, node) => {
        console.log(`Mouse enter node: ${node.id}`);
        setHoveredNodeId(node.id);
        // Example: Add a temporary class for hover effect
        // setNodes((nds) => nds.map(n => n.id === node.id ? { ...n, className: `${n.className} hovered` } : n));

        // const nodeW = node.measured?.width || node.style?.width || nodeWidth;
        // const nodeH = node.measured?.height || node.style?.height || nodeHeight;

        // // Project node's graph position (top-left corner) to screen coordinates
        // const nodeScreenPos = reactFlowInstance.flowToScreenPosition({
        //     x: node.position.x,
        //     y: node.position.y,
        // });

        // // Calculate position for tooltip (e.g., centered below the node)
        // const tooltipX = nodeScreenPos.x-10; // Centered horizontally
        // const tooltipY = nodeScreenPos.y  ;  // Positioned below the node with a 5px gap

        // setTooltipContent('Loading...'); // Show loading state
        // setTooltipPosition({ x: tooltipX, y:node.position.y });
        // setTooltipVisible(true);

        // --- Fetch Tooltip Data (Example) ---
        const currentNode = reactFlowInstance.getNode(node.id);
        if (currentNode ) {
            setNodes((nds) =>
                nds.map((n) => n.id === node.id ? { ...n, data: { ...n.data, tooltipHtml: 'Loading...' } } : n)
            );

            try {
                const response = await fetch(`${BACKEND_URL}/lookup/${node.id}`);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                console.log(`Tooltip data for ${node.id}:`, data);

                setNodes((nds) =>
                    nds.map((n) => {
                        if (n.id === node.id) {
                            return { ...n, data: { ...n.data, tooltipHtml: data.html || 'No details available.' } };
                        }
                        return n;
                    })
                );
            } catch (error) {
                console.error(`Failed to fetch tooltip data for ${node.id}:`, error);
                setNodes((nds) =>
                    nds.map((n) => {
                        if (n.id === node.id) {
                             if (n.data.tooltipHtml === 'Loading...') {
                                return { ...n, data: { ...n.data, tooltipHtml: 'Error loading details.' } };
                            }
                        }
                        return n;
                    })
                );
            }
        }
    }, [reactFlowInstance, setNodes, setHoveredNodeId]); // Dependencies

 
    const onNodeMouseLeave = useCallback((event, node: Node) => {
        console.log(`Mouse leave node: ${node.id}`);
        setHoveredNodeId(null); 
    }, [setHoveredNodeId]); 

    // --- Render Component ---
    return (
        // Ensure the container has a defined height for React Flow to render correctly
        <div style={{ height: '80vh', width: '100%', border: '1px solid #eee' }}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange} // Handles node dragging, selection, etc.
                onEdgesChange={onEdgesChange} // Handles edge selection, deletion
                onNodeClick={onNodeClick}
                onNodeMouseEnter={onNodeMouseEnter}
                onNodeMouseLeave={onNodeMouseLeave}
                // onConnect={onConnect} // If you need to handle edge creation interactively
                fitView // Zooms/pans to fit the graph initially
                fitViewOptions={{ padding: 0.1 }} // Add some padding on fitView
                nodesDraggable={true} // Allow nodes to be dragged
                nodesConnectable={false} // Disable connecting nodes by dragging handles (optional)
                className="my-react-flow-graph" // Add a class for specific styling
            >
                {/* Add UI Controls */}
                <Controls />
                <MiniMap nodeStrokeWidth={3} zoomable pannable />
                <Background variant="dots" gap={15} size={1} />

                {/* Graph Status and Participant Avatars */}
                <Panel position="top-left">
                    <div>Graph Status</div>
                    {Object.keys(typingUsers).length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>
                            {Object.entries(typingUsers).map(([uid, editor]) => {
                                const ps = participantStates[uid];
                                const displayName = ps?.name || uid;
                                const editorLabel = editor === 'team' ? 'Team Editor' : 'Personal Editor';
                                return (
                                    <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                        <span>
                                            <ParticipantLabel
                                                id={uid}
                                                name={displayName}
                                                photo={ps?.photo || null}
                                                avatarSize={16}
                                                textSize={12}
                                                suffix={` is typing in ${editorLabel}...`}
                                            />
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                        {Object.entries(participantStates).filter(([, ps]) => ps.status === 'available').map(([pid, ps]) => {
                            const ringColor = '#22c55e';
                            const tooltipText = 'Looking for a new task';
                            const showTooltip = participantHoverId === pid;
                            return (
                                <div
                                    key={pid}
                                    onMouseEnter={() => setParticipantHoverId(pid)}
                                    onMouseLeave={() => setParticipantHoverId(null)}
                                    title={tooltipText}
                                    style={{
                                        position: 'relative',
                                        width: 40,
                                        height: 40,
                                        borderRadius: '50%',
                                        padding: 3,
                                        border: `3px solid ${ringColor}`,
                                        background: '#fff',
                                        cursor: 'default',
                                    }}
                                >
                                    {ps.photo ? (
                                        <img
                                            src={ps.photo}
                                            alt={ps.name}
                                            style={{
                                                width: '100%',
                                                height: '100%',
                                                borderRadius: '50%',
                                                objectFit: 'cover',
                                            }}
                                        />
                                    ) : (
                                        <div
                                            style={{
                                                width: '100%',
                                                height: '100%',
                                                borderRadius: '50%',
                                                background: ringColor,
                                                color: '#fff',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: 14,
                                                fontWeight: 'bold',
                                            }}
                                        >
                                            {pid}
                                        </div>
                                    )}
                                    {showTooltip && (
                                        <div
                                            style={{
                                                position: 'absolute',
                                                left: '50%',
                                                bottom: '100%',
                                                transform: 'translateX(-50%) translateY(-6px)',
                                                padding: '6px 10px',
                                                background: 'rgba(0,0,0,0.9)',
                                                color: '#fff',
                                                fontSize: 12,
                                                borderRadius: 4,
                                                whiteSpace: 'nowrap',
                                                zIndex: 1002,
                                                pointerEvents: 'none',
                                            }}
                                        >
                                            {tooltipText}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </Panel>
              {/* Render NodeToolbar conditionally for hovered node */}
              {nodes.map((node) => (
                    <NodeToolbar
                        key={node.id} // React key prop
                        nodeId={node.id}
                        // Show only when this node is hovered AND tooltip data is not null/loading
                        isVisible={hoveredNodeId === node.id && node.data.tooltipHtml && node.data.tooltipHtml !== 'Loading...'}
                        position={Position.Top} // Adjust position (Top, Bottom, Left, Right)
                        align="center"           // Adjust alignment ('start', 'center', 'end')
                        offset={10}              // Adjust distance from node edge
                        className="custom-node-toolbar" // Optional: for CSS styling
                        style={{
                            background: 'rgba(0, 0, 0, 0.85)',
                            color: 'white',
                            padding: '8px 12px',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontFamily: 'sans-serif',
                            maxWidth: '350px',
                            whiteSpace: 'pre-wrap',
                            boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                            zIndex: 1001, 
                        }}
                    >

                        {node.data.tooltipHtml && node.data.tooltipHtml !== 'Loading...' && (
                            <div dangerouslySetInnerHTML={{ __html: node.data.tooltipHtml }} />
                        )}
                         {node.data.tooltipHtml === 'Loading...' && (
                            <div>Loading...</div>
                        )}
                    </NodeToolbar>
                ))}

              {/* Avatar badges on occupied nodes */}
              {Object.entries(participantStates)
                .filter(([, ps]) => ps.status === 'unavailable' && ps.currentTasks && ps.currentTasks.length > 0)
                .flatMap(([pid, ps]) =>
                  ps.currentTasks!.map((task) => (
                    <NodeToolbar
                        key={`avatar-${pid}-${task}`}
                        nodeId={task}
                        isVisible={true}
                        position={Position.Top}
                        align="end"
                        offset={-8}
                        style={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0, zIndex: 1000, pointerEvents: 'none' }}
                    >
                        <div
                            title={`${ps.name || pid} is working here`}
                            style={{
                                width: 28, height: 28, borderRadius: '50%',
                                border: '3px solid #ef4444', background: '#fff',
                                overflow: 'hidden',
                            }}
                        >
                            {ps.photo
                                ? <img src={ps.photo} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={ps.name} />
                                : <div style={{ width: '100%', height: '100%', background: '#ef4444', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold' }}>{pid}</div>
                            }
                        </div>
                    </NodeToolbar>
                  ))
                )}
            </ReactFlow>
        </div>
    );
};

export default GraphComponent;
