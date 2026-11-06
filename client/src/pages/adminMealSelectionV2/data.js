// Screenshot fixtures for the isolated admin design preview; never sent to an API.
export const ingredients = [{
  id: 'mushroom',
  name: 'Mushroom White',
  category: 'Fruits & Veg',
  sub: 'Vegetables',
  cost: '0.012',
  allergens: [],
  exclusion: 'Mushroom',
  used: 9,
  display: 'Mushroom'
}, {
  id: 'cheese',
  name: 'Cheese Pecorino Romano',
  category: 'Dairy',
  sub: 'Cheese',
  cost: '0.095',
  allergens: ['Dairy'],
  used: 3
}, {
  id: 'soy',
  name: 'Soy Sauce Light',
  category: 'Sauces & Dressings',
  sub: 'Asian',
  cost: '0.018',
  allergens: ['Soy', 'Gluten'],
  used: 14
}, {
  id: 'peanuts',
  name: 'Roasted Peanuts',
  category: 'Dry Goods',
  sub: 'Nuts & Seeds',
  cost: '0.041',
  allergens: null,
  used: 2
}, {
  id: 'coriander',
  name: 'Coriander Fresh',
  category: 'Fruits & Veg',
  sub: 'Herbs',
  cost: '0.030',
  allergens: [],
  exclusion: 'Coriander',
  used: 11
}, {
  id: 'chicken',
  name: 'Chicken Breast Frozen',
  category: 'Poultry',
  sub: 'Chicken',
  cost: '0.024',
  allergens: [],
  used: 61
}];
export const recipes = [{
  id: 'sweet',
  name: 'Sweet and Sour Chicken',
  category: 'Protein',
  protein: 'Chicken',
  yield: '75.9%',
  count: 4,
  allergens: ['Gluten', 'Soy'],
  status: 'Published',
  code: 'aa0167'
}, {
  id: 'rice',
  name: 'Basmati Rice',
  category: 'Carb',
  yield: '210%',
  count: 3,
  allergens: [],
  status: 'Published',
  code: '3f81c2'
}, {
  id: 'sauce',
  name: 'Sweet and Sour Sauce',
  category: 'Sauce',
  yield: '92%',
  count: 6,
  allergens: ['Gluten', 'Soy'],
  status: 'Published',
  code: '6b0e14'
}, {
  id: 'bo-kho',
  name: 'Bo Kho Beef',
  category: 'Protein',
  protein: 'Beef',
  yield: '71%',
  count: 7,
  allergens: null,
  status: 'Draft',
  code: '91d0aa'
}, {
  id: 'egg',
  name: 'Baked Egg and Veg',
  category: 'Breakfast',
  yield: '—',
  count: 5,
  allergens: ['Egg', 'Dairy'],
  status: 'Published',
  code: '0c7a52',
  nutrition: 'Cal: 152 · P: 11g | C: 9g | F: 8g'
}];
export const meals = [{
  id: 'sweet',
  name: 'Sweet and Sour Chicken',
  type: 'Sub',
  protein: 'Chicken',
  recipe: 'Sweet and Sour Chicken',
  carb: 'Basmati Rice',
  veg: 'Stir-fry Vegetables',
  sauce: 'Sweet and Sour Sauce',
  garnish: 'Sesame & Spring Onion',
  core: true,
  allergens: ['Gluten', 'Soy'],
  status: 'Published',
  served: 'Warm'
}, {
  id: 'chipotle',
  name: 'Creamy Chipotle Chicken',
  type: 'Sub',
  protein: 'Chicken',
  recipe: 'Creamy Chipotle Chicken',
  carb: 'Herb Potatoes',
  veg: 'Sauteed Mushroom & Greens',
  sauce: 'Chipotle Cream',
  allergens: ['Dairy'],
  status: 'Published',
  served: 'Warm'
}, {
  id: 'bo-kho',
  name: 'Bo Kho Beef',
  type: 'Main',
  protein: 'Beef',
  recipe: 'Bo Kho Beef',
  carb: 'Rice Noodles',
  veg: 'Asian Slaw',
  sauce: 'Bo Kho Broth',
  allergens: null,
  status: 'Draft',
  served: 'Warm'
}, {
  id: 'fiesta',
  name: 'Fiesta Minced Beef',
  type: 'Main',
  protein: 'Beef',
  recipe: '',
  carb: 'Mexican Rice',
  veg: 'Corn Salsa',
  sauce: 'Chipotle Sauce',
  allergens: [],
  status: 'Draft',
  served: 'Warm'
}, {
  id: 'hammour',
  name: 'Grilled Hammour',
  type: 'Main',
  protein: 'Fish',
  recipe: 'Grilled Hammour',
  carb: 'Quinoa',
  veg: 'Roasted Greens',
  sauce: 'Lemon Butter Sauce',
  allergens: ['Fish', 'Dairy'],
  status: 'Published',
  served: 'Warm'
}, {
  id: 'egg',
  name: 'Baked Egg and Veg',
  type: 'Breakfast',
  protein: 'Egg',
  recipe: 'Baked Egg and Veg',
  carb: 'Egg base',
  veg: 'Vegetables',
  allergens: ['Egg', 'Dairy'],
  status: 'Published'
}, {
  id: 'ball',
  name: 'Protein Ball',
  type: 'Snack',
  protein: '',
  recipe: 'Protein Ball',
  allergens: ['Nuts'],
  status: 'Published'
}];
export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
export const weekly = [[['Baked Egg and Veg', 'Biscoff Overnight Oats', 'Mix Berry Pancake'], ['Creamy Piri-Piri Shrimp', 'Lemon Herb Chicken', 'Fiesta Minced Beef'], ['Sweet and Sour Chicken', 'Beef Stroganoff'], ['Protein Ball', 'Hummus & Veg']], [['Eggs & Macaroni', 'Pistachio Oats', 'Banana Bread Slice'], ['Grilled Hammour', 'Honey Garlic Chicken', 'Bo Kho Beef'], ['Chicken Fajita', 'Mapo Style Chilli Beef'], ['Greek Yoghurt Cup', 'Date Bites']], [['Shakshuka Bowl', 'Apple Pie Oats', 'Blueberry Muffin'], ['Salmon Teriyaki', 'Peri-Peri Chicken', 'Marmalade Meatball'], ['Spicy Bomb Chicken', 'Beef Kafta Wrap'], ['Protein Ball', 'Edamame']], [['Savoury French Toast', 'Biscoff Overnight Oats', 'Carrot Cake Bake'], ['Thai Fish Curry', 'Sweet Mustard Chicken', 'Chilli Con Karne'], ['Chicken Shawarma', 'Beef Ragu'], ['Granola Bar', 'Hummus & Veg']], [['Eggs with Kimchi Quinoa', 'Savoury Corn Muffins', 'Bread Pudding'], ['Tuna Muscle Cake', 'Butter Chicken', 'Beef Bulgogi'], ['Creamy Chipotle Chicken', 'Kafta'], ['Chia Pudding', 'Date Bites']]];
export const kitchenRows = [['Aisha Mattar', 'Custom · 3', 'Baked Egg and Veg', '100 g', '100 g bread', '80 g', '22 / 24 / 14', '310', 'Customer'], ['Aisha Mattar', 'Custom · 3', 'Sweet and Sour Chicken', '160 g', '135 g rice', '80 g', '38 / 42 / 9', '401', 'Customer'], ['Aisha Mattar', 'Custom · 3', 'Creamy Chipotle Chicken', '152 g', '128 g potato', '80 g', '36 / 40 / 12', '412', 'Change veg'], ['Omar K.', 'Lean Plan 2', 'Kofta', '140 g', '115 g rice', '80 g', '35 / 36 / 11', '383', 'Chef pick'], ['Lina S.', 'Matter Core', 'Spicy Bomb Chicken', '150 g', '150 g rice', '80 g', '40 / 40 / 15', '455', 'Core'], ['Rami H.', 'Custom · 4', 'Beef Bulgogi', '240 g (capped)', '210 g rice', '80 g', '70 / 65 / 18', '702', 'Shortfall'], ['Nadia F.', 'Custom · 3', 'No meal assigned', '—', '—', '—', '—', '—', 'No safe dish']];
export const counts = [['Sweet and Sour Chicken', 'Sub', 142, '22.7 kg chicken', '19.2 kg rice', '11.4 kg', 142, '—'], ['Creamy Chipotle Chicken', 'Sub', 96, '14.9 kg chicken', '12.6 kg potato', '7.7 kg', 96, 'Change veg × 7'], ['Beef Bulgogi', 'Main', 120, '21.6 kg beef', '18.0 kg rice', '9.6 kg', 120, '—'], ['Kofta', 'Sub', 88, '13.2 kg beef', '11.0 kg rice', '7.0 kg', 88, 'Change carb × 3'], ['Grilled Hammour', 'Main', 64, '9.0 kg fish', '8.3 kg quinoa', '5.1 kg', 64, '—']];
