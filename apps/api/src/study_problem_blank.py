import random
from typing import List, Tuple, Optional
from study_problem_classes import Menu, Order, Customer, Restaurant

"""
study_problem_classes

class Menu:
    def __init__(self):
        self.dishes = {"chicken": 12.00, "pork": 10.00, "vegetables": 9.00, "rice": 12.00}


class Order:
    def __init__(self, uuid=0, items=None, cost=0):
        self.id = uuid
        self.items: List[str] = items if items is not None else []
        self.cost = cost


class Customer:
    def __init__(self, name):
        self.name = name
        self.order: Dict[int, Order] = {}


class Restaurant:
    def __init__(self):
        self.inventory = {"chicken": 4, "pork": 3, "vegetables": 12, "rice": 7}
        self.cook_time_in_minutes = {
            "chicken": 15,
            "pork": 12,
            "vegetables": 10,
            "rice": 30,
        }
        self.order_queue: List[Order] = []
"""


def view_menu(menu: Menu):
    """
    Display the menu items with their cost in the following format:

    item | cost
    chicken | 12.0

    The first line is a header followed by each item and its corresponding cost on a new line.
    Hint: Use .items()
    """
    pass


def create_order(customer: Customer) -> int:
    """
    Create a new order to the customer dictionary.

    The order will have a 4-digit unique id, an empty list of items, and a cost of 0.

    Note: Check if the uuid is not already in customer.order, if it is pick a new uuid
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


def add_to_queue(restaurant: Restaurant, customer: Customer):
    """
    Add an incoming customer orders (from the customer order dictionary)
    to the restaurant's order queue.

    Args:
        customer (Customer): The customer whose order is to be added.
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


def cook_time_helper(restaurant: Restaurant, item: str):
    """
    Retrieve the cooking time for a specific item.

    Args:
        item (str): The name of the item.

    Returns:
        int: The cooking time in minutes for the item or -1 if not found.
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


restaurant = Restaurant()
customer = Customer("Alice")
menu = Menu()


def run():
    view_menu(menu)
    id = create_order(customer)
    add_to_order(customer, id, menu, "chicken")
    add_to_order(customer, id, menu, "beef")
    add_to_order(customer, id, menu, "vegetables")

    remove_from_order(customer, id, menu, "vegetables")
    remove_from_order(customer, id, menu, "beef")

    get_receipt(customer, menu)

    add_to_queue(restaurant, customer)
    (id, time) = cook_order(restaurant)
    print(id, time)


run()
