import random
from typing import List, Tuple, Optional
from study_problem_classes import Menu, Order, Customer, Restaurant

def view_menu(menu: Menu):
    """
    Display the menu items with their cost in the following format:

    item | cost
    chicken | 12.0

    The first line is a header followed by each item and its corresponding cost on a new line.
    Hint: Use .items()
    """
    pass


def clear_order(customer: Customer, order_id: int):
    """
    Clear the order (look up the id) from the customer by removing all items and reset the
    cost to zero.

    After clearing, prints:
        Order cleared.

    Args:
        order_id: The order to be cleared.
    """
    pass


def view_order_summary(order: Order, menu: Menu):
    """
    Print a summary of the given order including each item with its cost and the total cost.


    Expected output format:
        Order Summary:
        chicken - $12.00
        pork - $10.00
        Total: $22.00

    Hint: Use `format(x, ".2f")` to format to the second decimal

    Args:
        order (Order): The order to summarize.
    """
    pass


def add_to_order(customer: Customer, order_id: int, menu: Menu, item: str):
    """
    Add an item to the order if it exists on the menu and is in the customer's
    order dictionary, update the total cost.

    Args:
        order_id (int): The order to update.
        item (str): The item to add.

    Returns:
        str: The name of the item if added successfully.

    Prints:
        "Added [item]: [cost]" if the item is on the menu.
        "Not on menu" if the item is not available.
        "No order found" if the order_id is not found.
    """
    pass


def remove_from_order(customer: Customer, order_id: int, menu: Menu, item: str) -> bool:
    """
    Remove an item from the customer's order if it exists in the customer's
    order dictionary, update the total cost.

    Args:
        order (Order): The order from which the item should be removed.
        item (str): The item to remove.

    Returns:
        bool: True if the item was removed; False if the item was not found in the order.

    Prints:
        "Removed [item]" if the removal is successful.
        "Not ordered" if the item is not in the order.
        "No order found" if the order_id is not found.
    """
    pass


def calculate_order_cost(order: Order, menu: Menu):
    """
    Calculate the total cost of the order based on the items ordered.

    Args:
        order (Order): The order for which the cost is calculated.

    Returns:
        float: The total cost computed from the menu prices.
    """
    pass


def get_receipt(customer: Customer, menu: Menu):
    """
    Print all orders from the customer's order dictionary:

        [Customer name]:
        -----
        [Order Id]
        Order Summary:
        [item ordered] - $[cost of item]
        [item ordered] - $[cost of item]
        Total: $[total cost of order]
        -----
        [Order Id]
        Order Summary:
        [item ordered] - $[cost of item]
        [item ordered] - $[cost of item]
        Total: $[total cost of order]
        -----
        $[total cost of all orders]

    The output must exactly follow this format.

    Args:
        customer (Customer): The customer orders to generate the receipt.
        menu (Menu): The menu of the restaurant.
    """
    pass

def cook_order(restaurant: Restaurant) -> Tuple[str, int]:
    """
    Process the latest order in the queue if there is sufficient inventory.

    For each item in the order, if available in inventory, the inventory is decremented
    and the item's cooking time is added to the total time.

    Returns:
        tuple: A tuple containing the order id and the total cooking time in minutes.
        If the queue is empty or the inventory runs out return (-1, 0)
    """
    pass


def restock_inventory(restaurant: Restaurant, item: str, amount: int):
    """
    Restock the inventory with a given amount for a specified item.

    Args:
        item (str): The item to restock.
        amount (int): The number of units to add.

    Prints:
        "Restocked [item]. New quantity: [quantity]" if the item exists.
        "[item] not found in inventory." if the item is not in the inventory.
    """
    pass


def inventory_helper(restaurant: Restaurant, item: str):
    """
    Check if the item is available in inventory and decrement its quantity by one if available.

    Args:
        item (str): The item to check.

    Returns:
        bool: True if the item was available and decremented; False otherwise.
    """
    pass


def average_cook_time(restaurant: Restaurant):
    """
    Calculate and print the average cooking time for all orders in the queue.

    Returns:
        float: The average cooking time in minutes. Returns 0 if there are no orders.

    Prints:
        "Average cooking time: [average] minutes." if orders exist, or
        "No orders in queue." if the queue is empty.
    """
    pass