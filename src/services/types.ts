export interface Dish {
  default_serves: number;
  ingredient_complete: boolean;
  id: string;
  name: string;
  category: string;
  category_name: string;
  ingredients: string[];
  steps: string;
  minutes: number;
  vegetarian: boolean;
  spicy: boolean;
  allergens: string[];
  image_id: string;
  image_url?: string;
  active: boolean;
  revision: number;
  default_price_minor?: number | null;
}
export interface KitchenSummary {
  id: string;
  name: string;
  role: "owner" | "cook" | "member";
}
export interface MealSummary {
  estimated_people: number;
  id: string;
  kitchen_id: string;
  title: string;
  status: string;
  scheduled_at: number;
  cutoff_at: number;
  revision: number;
  plan_confirmed: boolean;
  served: number;
}
export interface Kitchen extends KitchenSummary {
  image_id: string;
  description: string;
  can_price: boolean;
  revision: number;
  dishes: Dish[];
  meals: MealSummary[];
  members: { id: string; name: string; role: string }[];
}
export interface Selection {
  people: number;
  items: { dish_id: string; quantity: number }[];
  note: string;
  revision: number;
}
export interface Meal extends MealSummary {
  can_undo: boolean;
  role: "cook" | "member";
  cook_candidates?: { id: string; name: string }[];
  menu: Dish[];
  items: {
    dish_id: string;
    name: string;
    quantity: number;
    status: string;
    requested_people: number;
    reason: string;
  }[];
  selection: Selection;
  participant_count: number;
  requests?: {
    name: string;
    items: Selection["items"];
    note: string;
    people?: number;
  }[];
  summary?: {
    dish_id: string;
    name: string;
    people: number;
    requested_quantity: number;
  }[];
  chef_prices?: {
    dish_id: string;
    name: string;
    unit_price_minor: number | null;
  }[];
  chef_quote?: {
    lines: {
      dish_id: string;
      unit_price_minor: number | null;
      subtotal_minor: number | null;
    }[];
    total_known_minor: number;
    unpriced_count: number;
    revision: number;
  };
}
export interface Profile {
  name: string;
  kitchens: KitchenSummary[];
  limits: Record<string, number>;
  features: {
    paid: boolean;
    notifications: boolean;
    template_id: string;
    media?: boolean;
    poster?: boolean;
  };
}
export interface Recommendation {
  id: string;
  name: string;
  reason: string;
  warning: string;
  items: { dish_id: string; name: string; quantity: number }[];
}
