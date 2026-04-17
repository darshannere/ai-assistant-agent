from textwrap import dedent


CONCEPT_REFERENCE_TEMPLATES = {
    "view_menu": {
        "String Interpolation": {
            "solution_snippet": 'print(f"{k} | {v}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Looping": {
            "solution_snippet": "for k, v in menu.dishes.items():\n    print(f\"{k} | {v}\")",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Dictionary concepts": {
            "solution_snippet": "for k, v in menu.dishes.items():",
            "patterns": [r"\.items\(", r"\[[^\]]+\]"],
        },
    },
    "create_order": {
        "Random num generation": {
            "solution_snippet": "uuid = random.randint(1000, 9999)",
            "patterns": [r"random\.\w+\(", r"randint\("],
        },
        "Looping (while loop)": {
            "solution_snippet": "while uuid in customer.order:\n    uuid = random.randint(1000, 9999)",
            "patterns": [r"^\s*while\b"],
        },
        "Object initialization": {
            "solution_snippet": "customer.order[uuid] = Order(uuid)",
            "patterns": [r"\bOrder\("],
        },
        "Dictionary Operation": {
            "solution_snippet": "customer.order[uuid] = Order(uuid)",
            "patterns": [r"\.order\[", r"\[[^\]]+\]\s*="],
        },
    },
    "clear_order": {
        "Dictionary Lookup": {
            "solution_snippet": "customer.order[order_id].items.clear()",
            "patterns": [r"\.order\[", r"\[[^\]]+\]"],
        },
        "List Operations": {
            "solution_snippet": "customer.order[order_id].items.clear()",
            "patterns": [r"\.clear\(", r"\.append\(", r"\.remove\(", r"\.pop\("],
        },
    },
    "view_order_summary": {
        "Looping": {
            "solution_snippet": "for item in order.items:\n    print(f\"{item} - ${menu.dishes[item]:.2f}\")",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "String Interpolation": {
            "solution_snippet": 'print(f"{item} - ${menu.dishes[item]:.2f}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Function Calling": {
            "solution_snippet": 'print(f"Total: ${calculate_order_cost(order, menu):.2f}")',
            "patterns": [r"\bcalculate_order_cost\("],
        },
    },
    "add_to_order": {
        "Conditional Statement (If-else)": {
            "solution_snippet": dedent("""
                if order_id in customer.order:
                    order = customer.order[order_id]
                    if item in menu.dishes:
                        ...
                else:
                    print("No order found")
            """).strip(),
            "patterns": [r"^\s*if\b", r"^\s*else\b"],
        },
        "List concepts": {
            "solution_snippet": "order.items.append(item)",
            "patterns": [r"\.append\(", r"\.remove\(", r"\.pop\(", r"\.clear\("],
        },
        "String Interpolation": {
            "solution_snippet": 'print(f"Added {item}: {menu.dishes[item]}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Function Calling": {
            "solution_snippet": "order.cost = calculate_order_cost(order, menu)",
            "patterns": [r"\bcalculate_order_cost\("],
        },
    },
    "remove_from_order": {
        "Conditional Statement (If-else)": {
            "solution_snippet": dedent("""
                if order_id in customer.order:
                    ...
                else:
                    print("No order found")
                    return False
            """).strip(),
            "patterns": [r"^\s*if\b", r"^\s*else\b"],
        },
        "List concepts": {
            "solution_snippet": "order.items.remove(item)",
            "patterns": [r"\.remove\(", r"\.append\(", r"\.pop\(", r"\.clear\("],
        },
        "String Interpolation": {
            "solution_snippet": 'print(f"Removed {item}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Function Calling": {
            "solution_snippet": "order.cost = calculate_order_cost(order, menu)",
            "patterns": [r"\bcalculate_order_cost\("],
        },
    },
    "calculate_order_cost": {
        "Looping": {
            "solution_snippet": "for i in order.items:\n    cost += menu.dishes[i]",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Dictionary concepts": {
            "solution_snippet": "cost += menu.dishes[i]",
            "patterns": [r"\[[^\]]+\]", r"\.items\("],
        },
    },
    "get_receipt": {
        "String Interpolation": {
            "solution_snippet": 'print(f"${total:.2f}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Looping": {
            "solution_snippet": "for k, v in customer.order.items():\n    ...",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Function Calling": {
            "solution_snippet": "view_order_summary(v, menu)",
            "patterns": [r"\bview_order_summary\("],
        },
        "Dictionary iteration": {
            "solution_snippet": "for k, v in customer.order.items():",
            "patterns": [r"\.items\("],
        },
    },
    "add_to_queue": {
        "List Operations": {
            "solution_snippet": "restaurant.order_queue.append(order)",
            "patterns": [r"\.append\("],
        },
        "Looping": {
            "solution_snippet": "for id, order in customer.order.items():\n    restaurant.order_queue.append(order)",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Dictionary iteration": {
            "solution_snippet": "for id, order in customer.order.items():",
            "patterns": [r"\.items\("],
        },
    },
    "cook_order": {
        "List Operations": {
            "solution_snippet": "order = restaurant.order_queue.pop()",
            "patterns": [r"\.pop\(", r"\.append\(", r"\.remove\(", r"\.clear\("],
        },
        "Function Calling": {
            "solution_snippet": "if inventory_helper(restaurant, item):\n    time += cook_time_helper(restaurant, item)",
            "patterns": [r"\binventory_helper\(", r"\bcook_time_helper\("],
        },
        "Tuple": {
            "solution_snippet": "return (order.id, time)",
            "patterns": [r"return\s*\("],
        },
        "Looping": {
            "solution_snippet": "for item in order.items:\n    ...",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Conditional (if-else)": {
            "solution_snippet": "if restaurant.order_queue:\n    ...\nelse:\n    return (-1, 0)",
            "patterns": [r"^\s*if\b", r"^\s*else\b"],
        },
    },
    "restock_inventory": {
        "Conditional Statement (if-else)": {
            "solution_snippet": "if item in restaurant.inventory:\n    ...\nelse:\n    print(f\"{item} not found in inventory.\")",
            "patterns": [r"^\s*if\b", r"^\s*else\b"],
        },
        "String Interpolation": {
            "solution_snippet": 'print(f"Restocked {item}. New quantity: {restaurant.inventory[item]}")',
            "patterns": [r'f["\']', r"\.format\("],
        },
        "Dictionary concepts": {
            "solution_snippet": "restaurant.inventory[item] += amount",
            "patterns": [r"\.inventory\[", r"\[[^\]]+\]"],
        },
    },
    "cook_time_helper": {
        "Dictionary Operations": {
            "solution_snippet": "return restaurant.cook_time_in_minutes[item] if item in restaurant.cook_time_in_minutes else -1",
            "patterns": [r"\.cook_time_in_minutes\[", r"\[[^\]]+\]"],
        },
        "Conditional": {
            "solution_snippet": "return restaurant.cook_time_in_minutes[item] if item in restaurant.cook_time_in_minutes else -1",
            "patterns": [r"\bif\b", r"\belse\b"],
        },
    },
    "inventory_helper": {
        "Conditional Statements": {
            "solution_snippet": "if item in restaurant.inventory and restaurant.inventory[item] > 0:\n    ...\nreturn False",
            "patterns": [r"^\s*if\b", r"^\s*else\b"],
        },
        "Dictionary Operations": {
            "solution_snippet": "restaurant.inventory[item] -= 1",
            "patterns": [r"\.inventory\[", r"\[[^\]]+\]"],
        },
    },
    "average_cook_time": {
        "Looping": {
            "solution_snippet": "for i in restaurant.order_queue:\n    ...",
            "patterns": [r"^\s*for\b", r"^\s*while\b"],
        },
        "Function Calling": {
            "solution_snippet": "time += cook_time_helper(restaurant, item)",
            "patterns": [r"\bcook_time_helper\("],
        },
        "String Interpolation": {
            "solution_snippet": 'print(f"Average cooking time: {average_time:.2f} minutes.")',
            "patterns": [r'f["\']', r"\.format\("],
        },
    },
}
