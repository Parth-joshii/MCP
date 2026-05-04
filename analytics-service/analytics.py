import pandas as pd
from pymongo import MongoClient
import os
from urllib.parse import urlparse
from datetime import datetime, timedelta

DEFAULT_MONGO_DB = "ai-ecommerce"

def database_name_from_uri(uri: str) -> str:
    path = urlparse(uri).path.strip("/")
    return path.split("/")[0] if path else ""

MONGO_URI = os.getenv("MONGO_URI", f"mongodb://localhost:27017/{DEFAULT_MONGO_DB}")
MONGO_DB_NAME = (
    os.getenv("MONGO_DB_NAME")
    or os.getenv("MONGO_DATABASE")
    or database_name_from_uri(MONGO_URI)
    or DEFAULT_MONGO_DB
)
client = MongoClient(MONGO_URI)
db = client[MONGO_DB_NAME]

def get_orders_df():
    orders = list(db.orders.find())
    if not orders:
        return pd.DataFrame()
    return pd.DataFrame(orders)

def get_products_df():
    products = list(db.products.find())
    if not products:
        return pd.DataFrame()
    return pd.DataFrame(products)

def calculate_total_revenue():
    df = get_orders_df()
    if df.empty:
        return {"totalRevenue": 0, "orderCount": 0}
    
    total_revenue = float(df['totalAmount'].sum())
    order_count = int(df['_id'].count())
    return {"totalRevenue": total_revenue, "orderCount": order_count}

def get_top_products(limit: int = 5):
    orders = list(db.orders.find({}, {"items": 1}))
    if not orders:
        return []
    
    # Flatten items
    items_list = []
    for order in orders:
        items_list.extend(order.get('items', []))
    
    if not items_list:
        return []

    df = pd.DataFrame(items_list)
    
    # We need to get product names. Join with products collection.
    # In MongoDB, product field is ObjectId.
    products_dict = {p['_id']: p['name'] for p in db.products.find()}
    
    df['product_name'] = df['product'].map(products_dict)
    
    # Aggregate sales
    top_selling = df.groupby('product_name')['quantity'].sum().sort_values(ascending=False).head(limit)
    
    result = []
    for name, qty in top_selling.items():
        result.append({"name": name, "sales": int(qty)})
        
    return result

def get_sales_trend(days: int = 7):
    df = get_orders_df()
    if df.empty:
        return []

    # Filter by last N days
    cutoff_date = datetime.now() - timedelta(days=days)
    
    # Ensure date is datetime
    df['date'] = pd.to_datetime(df['date'])
    
    # Filter
    mask = df['date'] >= cutoff_date
    recent_df = df.loc[mask].copy()
    
    if recent_df.empty:
        return []
    
    # Group by date
    recent_df['day'] = recent_df['date'].dt.strftime('%Y-%m-%d')
    trend = recent_df.groupby('day')['totalAmount'].sum().reset_index()
    
    result = []
    for _, row in trend.iterrows():
        result.append({"date": row['day'], "revenue": float(row['totalAmount'])})
        
    return result

def get_unique_values(field: str):
    df = get_orders_df()
    if df.empty or field not in df.columns:
        return []
    return df[field].dropna().unique().tolist()

def get_sales_by_filter(field: str, value: str):
    df = get_orders_df()
    if df.empty or field not in df.columns:
        return {"totalRevenue": 0, "orderCount": 0}
    
    filtered_df = df[df[field] == value]
    total_revenue = float(filtered_df['totalAmount'].sum())
    order_count = int(filtered_df['_id'].count())
    return {"totalRevenue": total_revenue, "orderCount": order_count}
