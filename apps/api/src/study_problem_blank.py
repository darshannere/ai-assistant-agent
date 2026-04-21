import random
from typing import List, Tuple, Optional
from study_problem_classes import Menu, Order, Customer, Restaurant

def view_menu(menu: Menu):
    """
    Display the menu items with their cost in the required header-and-rows format.

    Example:
        Input:
            menu = Menu()
            view_menu(menu)

        Returns:
            None

        Prints:
            item | cost
            chicken | 12.0
            pork | 10.0
            vegetables | 9.0
            rice | 12.0

    Args:
        menu: The menu whose dishes should be printed.
    """
    pass


def clear_order(customer: Customer, order_id: int):
    """
    Clear one existing order by removing all items and resetting its total cost to zero.

    Example:
        Input:
            customer = Customer('amy')
            customer.order[1234] = Order(1234, ['chicken', 'rice'], 17.0)
            clear_order(customer, 1234)

        Returns:
            None

        Prints:
            Order cleared.

    Args:
        customer: The customer who owns the order.
        order_id: The id of the order to clear.
    """
    pass


def view_order_summary(order: Order, menu: Menu):
    """
    Print a summary of an order, including each item and the final total with two decimals.

    Example:
        Input:
            menu = Menu()
            order = Order('Bobby', ['chicken', 'vegetables'], 21)
            view_order_summary(order, menu)

        Returns:
            None

        Prints:
            Order Summary:
            chicken - $12.00
            vegetables - $9.00
            Total: $21.00

    Args:
        order: The order to summarize.
        menu: The menu used to look up each item's price.
    """
    pass


def add_to_order(customer: Customer, order_id: int, menu: Menu, item: str):
    """
    Add one menu item to an existing order and recompute the order cost.

    Example:
        Input:
            customer = Customer('amy')
            customer.order[1234] = Order(1234)
            menu = Menu()
            add_to_order(customer, 1234, menu, 'chicken')

        Returns:
            'chicken'

        Prints:
            Added chicken: 12.0

    Args:
        customer: The customer who owns the order.
        order_id: The id of the order to update.
        menu: The menu used to validate and price the item.
        item: The item name to add.
    """
    pass


def remove_from_order(customer: Customer, order_id: int, menu: Menu, item: str) -> bool:
    """
    Remove one item from an existing order and update the total cost.

    Example:
        Input:
            customer = Customer('bob')
            customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)
            menu = Menu()
            remove_from_order(customer, 1234, menu, 'chicken')

        Returns:
            True

        Prints:
            Removed chicken

    Args:
        customer: The customer who owns the order.
        order_id: The id of the order to update.
        menu: The menu used to recompute the order cost.
        item: The item name to remove.
    """
    pass


def calculate_order_cost(order: Order, menu: Menu):
    """
    Calculate and return the total cost of all items currently in the order.

    Example:
        Input:
            menu = Menu()
            order = Order(1234, ['chicken', 'rice'], 0)
            calculate_order_cost(order, menu)

        Returns:
            24.0

        Prints:
            None

    Args:
        order: The order whose items should be priced.
        menu: The menu used to look up prices.
    """
    pass


def get_receipt(customer: Customer, menu: Menu):
    """
    Print a full receipt for every order the customer currently has.

    Example:
        Input:
            menu = Menu()
            customer = Customer('bob')
            customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)
            customer.order[5678] = Order(5678, ['rice'], 12.0)
            get_receipt(customer, menu)

        Returns:
            None

        Prints:
            bob
            -----
            1234
            Order Summary:
            chicken - $12.00
            rice - $12.00
            Total: $24.00
            -----
            5678
            Order Summary:
            rice - $12.00
            Total: $12.00
            -----
            $36.00

    Args:
        customer: The customer whose orders should be printed.
        menu: The menu used to look up item prices.
    """
    pass

def cook_order(restaurant: Restaurant) -> Tuple[str, int]:
    """
    Cook the most recently queued order if the restaurant has enough inventory.

    Example:
        Input:
            restaurant = Restaurant()
            restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}
            restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}
            customer = Customer('bob')
            customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)
            customer.order[5678] = Order(5678, ['rice'], 12.0)
            add_to_queue(restaurant, customer)
            cook_order(restaurant)

        Returns:
            (5678, 2)

        Prints:
            None

    Args:
        restaurant: The restaurant whose queue and inventory should be updated.
    """
    pass


def restock_inventory(restaurant: Restaurant, item: str, amount: int):
    """
    Increase the inventory count of one existing item.

    Example:
        Input:
            restaurant = Restaurant()
            restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}
            restock_inventory(restaurant, 'chicken', 2)

        Returns:
            None

        Prints:
            Restocked chicken. New quantity: 3

    Args:
        restaurant: The restaurant whose inventory should change.
        item: The item name to restock.
        amount: The quantity to add.
    """
    pass


def inventory_helper(restaurant: Restaurant, item: str):
    """
    Return whether one unit of an item can be used, and decrement that item's inventory if so.

    Example:
        Input:
            restaurant = Restaurant()
            restaurant.inventory = {'chicken': 1, 'rice': 1, 'vegetables': 1}
            inventory_helper(restaurant, 'rice')

        Returns:
            True

        Prints:
            None

    Args:
        restaurant: The restaurant whose inventory should be checked.
        item: The item name to consume.
    """
    pass


def average_cook_time(restaurant: Restaurant):
    """
    Compute the average cook time across all currently queued orders and print it.

    Example:
        Input:
            restaurant = Restaurant()
            restaurant.cook_time_in_minutes = {'chicken': 3, 'rice': 2, 'vegetables': 1}
            customer = Customer('bob')
            customer.order[1234] = Order(1234, ['chicken', 'rice'], 24.0)
            customer.order[5678] = Order(5678, ['rice'], 12.0)
            add_to_queue(restaurant, customer)
            average_cook_time(restaurant)

        Returns:
            3.5

        Prints:
            Average cooking time: 3.50 minutes.

    Args:
        restaurant: The restaurant whose queue should be averaged.
    """
    pass
