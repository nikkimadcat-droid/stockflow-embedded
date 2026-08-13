import dotenv from "dotenv";
dotenv.config();

import prisma from "../db.server.js";

const SHOP = "8a7777-3c.myshopify.com";
const WILLY_LOCATION_GID = "gid://shopify/Location/75811291387";

const scrapedRows = [
  { rowText: ["Weruva FD Mideast Feast - 7oz","Default Title","M27262","810028245310","Weruva","-","-","4","",""], inputValues: ["1","2"] },
  { rowText: ["Weruva FD Paw Lickin Chx - 1oz","Default Title","M27100","810028242944","Weruva","-","-","0","",""], inputValues: ["1","2"] },
  { rowText: ["Weruva FD Paw Lickin Chx - 7oz","Default Title","M27099","810028242951","Weruva","-","-","6","",""], inputValues: ["1","2"] },
  { rowText: ["Weruva Tea Potty - 11.7#","Default Title","M16783","878408000836","Weruva","-","-","0","",""], inputValues: ["3","5"] },
  { rowText: ["Weruva Tea Potty - 6.7#","Default Title","M16782","878408000829","Weruva","-","-","-1","",""], inputValues: ["3","5"] },
  { rowText: ["Weruva Wx - FD Chx/Tilapia - 1oz","Default Title","M27101","810028248984","Weruva","-","-","29","",""], inputValues: ["3","5"] },
  { rowText: ["Weruva Wx - FD Chx/Tilapia - 7oz","Default Title","M27102","810028244559","Weruva","-","-","3","",""], inputValues: ["3","5"] },
  { rowText: ["Weruva Wx - Gravy - Chicken - 3oz (yellow)","Default Title","M16517","810028242678","Weruva","-","-","28","",""], inputValues: ["24","36"] },
  { rowText: ["Weruva Wx - Gravy - Chicken - 5.5oz (yellow)","Default Title","M27832","810028246027","Weruva","-","-","24","",""], inputValues: ["",""] },
  { rowText: ["Weruva Wx - Gravy - Chx/Tilapia - 3oz (blue)","Default Title","M16518","810028242432","Weruva","-","-","28","",""], inputValues: ["24","48"] },
  { rowText: ["Weruva Wx - Gravy - Chx/Tilapia - 5.5oz (blue)","Default Title","M27833","810028246034","Weruva","-","-","19","",""], inputValues: ["",""] },
  { rowText: ["Weruva Wx - Phos Focused Treats - 5pk - Chicken","Default Title","M26863","810028246874","Weruva","-","-","94","",""], inputValues: ["3","6"] },
  { rowText: ["Weruva Wx - Phos Focused Treats - 5pk - Chicken/Tilapia","Default Title","M26862","810028246881","Weruva","-","-","18","",""], inputValues: ["3","6"] },
  { rowText: ["Weruva Wx - Phos Focused Treats - 5pk - Tuna","Default Title","M26864","810028246898","Weruva","-","-","16","",""], inputValues: ["3","6"] },
  { rowText: ["Weruva Wx - Puree - Chicken - 3oz (brown)","Default Title","M15133","810028242647","Weruva","-","-","26","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva Wx - Puree - Chicken - 5.5oz (brown)","Default Title","M27834","810028246010","Weruva","-","-","20","",""], inputValues: ["",""] },
  { rowText: ["Weruva Wx - Puree - Tilapia/Chx - 3oz (teal)","Default Title","M16520","810028242661","Weruva","-","-","55","",""], inputValues: ["24","0"] },
  { rowText: ["Weruva Wx - Puree - Tilapia/Chx - 5.5oz (teal)","Default Title","M27836","810028246041","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["Weruva Wx - Puree - Tuna/Tilapia - 3oz (purple)","Default Title","M16519","810028242654","Weruva","-","-","108","",""], inputValues: ["24","48"] },
  { rowText: ["Weruva Wx - Puree - Tuna/Tilapia - 5.5oz (purple)","Default Title","M27835","810028246058","Weruva","-","-","24","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz - grandmas chx","Default Title","M20310","878408000324","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Amazon Livin","Default Title","M20316","878408000348","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Asian Fusion","Default Title","M20313","878408000133","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Green Eggs&Chx","Default Title","M20311","878408000355","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Mack N Jack","Default Title","M20314","878408000140","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Mideast Feast","Default Title","M20312","878408000171","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 3oz Paw Lickin","Default Title","M20315","878408000317","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 5.5oz Marbella Paella","Default Title","M28020","878408000027","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 5.5oz Meow Luau","Default Title","M28019","878408000065","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - 5.5oz Outback Grill","Default Title","M28018","878408000010","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Amazon Livin - 5.5oz","Default Title","M20942","","PFX","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["WeruvaCase - Amazon Livin - 5.5oz","Default Title","M20942","878408000249","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Asian fusion - 5.5oz","Default Title","M20941","","PFX","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["WeruvaCase - Asian fusion - 5.5oz","Default Title","M20941","878408000034","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - chick magnet (green)","Default Title","M20916","878408001727","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - Love me (purp)","Default Title","M20919","878408001734","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - mack jack (red)","Default Title","M20918","878408001765","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - One if by land (blue)","Default Title","M20917","878408001758","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - Pumpkin Jack (org)","Default Title","M20920","878408001741","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - CIK - Pumpkin Lick (yel)","Default Title","M20921","878408001710","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Bed+Bfast - 14oz","Default Title","M20299","878408006227","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Cirque De La Mer - 14oz","Default Title","M20298","878408006104","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Funky Chunky - 14oz","Default Title","M20297","878408006135","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Hot Dayam - 14oz","Default Title","M20296","878408004551","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Jammin Salmon - 14oz","Default Title","M20295","878408006197","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Marbella Paella - 14oz","Default Title","M20294","878408006210","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Paw Licken - 14oz","Default Title","M20293","878408006111","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Peking Ducken - 14oz","Default Title","M20292","878408004537","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Steak Frites - 14oz","Default Title","M20291","894408006180","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WeruvaCase - Dog - Wok the dog - 14oz","Default Title","M20289","878408006173","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["Weruva - Kitten - Chx/Pump 3oz (blue)","Default Title","M16546","810028242791","Weruva","-","-","10","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva - Kitten - Chx/Tuna 3oz (green)","Default Title","M16547","810028242807","Weruva","-","-","71","",""], inputValues: ["36","144"] },
  { rowText: ["Weruva - Kitten - Tuna/Sal 3oz (org)","Default Title","M16549","810028242814","Weruva","-","-","19","",""], inputValues: ["72","144"] },
  { rowText: ["Weruva - Pate - Jolly - 3oz (pink)","Default Title","M16529","813778018371","Weruva","-","-","75","",""], inputValues: ["24","60"] },
  { rowText: ["Weruva - Pate - Jolly - 5oz (pink)","Default Title","M16542","813778018234","Weruva","-","-","64","",""], inputValues: ["32","96"] },
  { rowText: ["Weruva - Pate - Meal/Deal - 3oz(purp)","Default Title","M16531","813778018364","Weruva","-","-","29","",""], inputValues: ["12","36"] },
  { rowText: ["Weruva - Pate - Meal/Deal - 5oz(purp)","Default Title","M16544","813778018227","Weruva","-","-","41","",""], inputValues: ["16","32"] },
  { rowText: ["Weruva - Pate - Meowionaire - 3oz (orangy)","Default Title","M16528","813778018357","Weruva","-","-","62","",""], inputValues: ["24","60"] },
  { rowText: ["Weruva - Pate - Meowionaire - 5oz (orangy)","Default Title","M16541","813778018210","Weruva","-","-","97","",""], inputValues: ["16","80"] },
  { rowText: ["Weruva - Pate - Press Din - 3oz (yellow)","Default Title","M16526","810028241442","Weruva","-","-","36","",""], inputValues: ["36","96"] },
  { rowText: ["Weruva - Pate - Press Din - 5oz (yellow)","Default Title","M16539","810028241473","Weruva","-","-","61","",""], inputValues: ["32","96"] },
  { rowText: ["Weruva - Pate - Press lunch - 3oz (blue)","Default Title","M16527","813778018395","Weruva","-","-","53","",""], inputValues: ["36","96"] },
  { rowText: ["Weruva - Pate - Press lunch - 5oz (blue)","Default Title","M16540","813778018258","Weruva","-","-","17","",""], inputValues: ["48","112"] },
  { rowText: ["Weruva - Pate - Purramid - 3oz (mint)","Default Title","M16532","813778018388","Weruva","-","-","40","",""], inputValues: ["12","36"] },
  { rowText: ["Weruva - Pate - Purramid - 5oz (mint)","Default Title","M16545","813778018241","Weruva","-","-","46","",""], inputValues: ["8","24"] },
  { rowText: ["Weruva - Pate - Tic Tac - 3oz (magenta)","Default Title","M16530","813778018340","Weruva","-","-","13","",""], inputValues: ["48","120"] },
  { rowText: ["Weruva - Pate - Tic Tac - 5oz (magenta)","Default Title","M16543","813778018203","Weruva","-","-","46","",""], inputValues: ["32","144"] },
  { rowText: ["Weruva - Pumpkin Patch Up - 2.8oz","Default Title","M14743","878408000720","Weruva","-","-","34","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva - Pumpkin Patch Up - Coconut/Flax - 2.8oz","Default Title","M27468","810028241206","Weruva","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["Weruva - Pumpkin Patch Up - Ginger/Turmeric - 2.8oz","Default Title","M27469","810028241145","Weruva","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["Weruva - Senior - chx gravy 3oz (yellow)","Default Title","M27436","810028246324","Weruva","-","-","31","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - chx gravy 5oz (yellow)","Default Title","M27439","810028246447","Weruva","-","-","91","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - chx puree 3oz (green)","Default Title","M27433","810028246317","Weruva","-","-","14","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - chx puree 5oz (green)","Default Title","M27434","810028246430","Weruva","-","-","112","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - chx/tuna 3oz (blue)","Default Title","M27438","810028246348","Weruva","-","-","44","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - chx/tuna 5oz (blue)","Default Title","M27442","810028246461","Weruva","-","-","105","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - tuna/sal 3oz (pink)","Default Title","M27437","810028246331","Weruva","-","-","22","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Senior - tuna/sal 5oz (pink)","Default Title","M27441","810028246454","Weruva","-","-","27","",""], inputValues: ["15","48"] },
  { rowText: ["Weruva - Slide - Jeopurrdy - 2.8oz (blue)","Default Title","M15134","813778018999","Weruva","-","-","22","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva - Slide - Love Connection - 2.8oz (org)","Default Title","M16514","813778018982","Weruva","-","-","49","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva - Slide - Newly Feds - 2.8oz (purp)","Default Title","M16515","813778018968","Weruva","-","-","47","",""], inputValues: ["12","60"] },
  { rowText: ["Weruva - Slide - Slice Is Right - 2.8oz (yel)","Default Title","M16516","813778018937","Weruva","-","-","5","",""], inputValues: ["24","72"] },
  { rowText: ["Weruva Classic - 3oz Amazon Livin'","Default Title","M16524","878408001147","Weruva","-","-","48","",""], inputValues: ["24","48"] },
  { rowText: ["Weruva Classic - 3oz Asian Fusion","Default Title","M16525","878408001031","Weruva","-","-","38","",""], inputValues: ["24","48"] },
  { rowText: ["Weruva Classic - 3oz Grandma's Chicken Soup","Default Title","M16523","878408001123","Weruva","-","-","9","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva Classic - 3oz Green Eggs & Chicken","Default Title","M20045","878408001154","Weruva","-","-","20","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva Classic - 3oz Mack & Jack","Default Title","M16522","878408001048","Weruva","-","-","17","",""], inputValues: ["24","48"] },
  { rowText: ["Weruva Classic - 3oz Mideast Feast","Default Title","M13348","878408001079","Weruva","-","-","20","",""], inputValues: ["24","96"] },
  { rowText: ["Weruva Classic - 3oz Paw Lickin' Chicken","Default Title","M16521","878408001116","Weruva","-","-","29","",""], inputValues: ["48","96"] },
  { rowText: ["Weruva Classic - 5.5oz Amazon Livin'","Default Title","M16536","878408002144","Weruva","-","-","60","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva Classic - 5.5oz Asian Fusion","Default Title","M16538","878408002038","Weruva","-","-","17","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva Classic - 5.5oz Funky Chunky","Default Title","M16537","878408002137","Weruva","-","-","95","",""], inputValues: ["48","72"] },
  { rowText: ["Weruva Classic - 5.5oz Mack & Jack","Default Title","M16534","878408002045","Weruva","-","-","62","",""], inputValues: ["48","72"] },
  { rowText: ["Weruva Classic - 5.5oz Marbella Paella","Default Title","M28017","878408002021","Weruva","-","-","62","",""], inputValues: ["",""] },
  { rowText: ["Weruva Classic - 5.5oz Meow Luau","Default Title","M28016","878408002069","Weruva","-","-","43","",""], inputValues: ["",""] },
  { rowText: ["Weruva Classic - 5.5oz Mideast Feast","Default Title","M16533","878408002076","Weruva","-","-","10","",""], inputValues: ["48","120"] },
  { rowText: ["Weruva Classic - 5.5oz Outback Grill","Default Title","M28015","878408002014","Weruva","-","-","59","",""], inputValues: ["",""] },
  { rowText: ["Weruva Classic - 5.5oz Paw Lickin' Chicken","Default Title","M15101","878408002113","Weruva","-","-","31","",""], inputValues: ["120","288"] },
  { rowText: ["Weruva Classic - 5.5oz Polynesian BBQ","Default Title","M16535","878408002083","Weruva","-","-","9","",""], inputValues: ["48","72"] },
  { rowText: ["Weruva FD Mideast Feast - 1oz","Default Title","M27261","810028245297","Weruva","-","-","0","",""], inputValues: ["1","2"] },
  { rowText: ["CIK - Goldie Lox - 3oz (gold)","Default Title","M27712","878408008290","Weruva","-","-","26","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Goldie Lox - 6oz (gold)","Default Title","M27715","878408008733","Weruva","-","-","45","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Kitty Gone Wild - 3oz (pink)","Default Title","M27865","878408008306","Weruva","-","-","16","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Kitty Gone Wild - 6oz (pink)","Default Title","M27864","878408008740","Weruva","-","-","26","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - La Isla Bonita - 3oz (purple)","Default Title","M27711","878408008283","Weruva","-","-","59","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - La Isla Bonita - 6oz (purple)","Default Title","M27716","878408008726","Weruva","-","-","47","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Lamb Burgerini - 3oz (green)","Default Title","M27709","878408008702","Weruva","-","-","17","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Lamb Burgerini - 6oz (green)","Default Title","M27710","878408008788","Weruva","-","-","30","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Two Tu Tango - 3oz (red)","Default Title","M27713","878408008276","Weruva","-","-","17","",""], inputValues: ["6","48"] },
  { rowText: ["CIK - Two Tu Tango - 6oz (red)","Default Title","M27714","878408008719","Weruva","-","-","41","",""], inputValues: ["6","48"] },
  { rowText: ["CIK pouch - Chick Magnet (green)","Default Title","M16513","878408008221","Weruva","-","-","45","",""], inputValues: ["12","36"] },
  { rowText: ["CIK pouch - Love Me Tender (purple)","Default Title","M16510","878408008238","Weruva","-","-","48","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - Mack Jack Sam (red)","Default Title","M16509","878408008269","Weruva","-","-","44","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - One if By Land (blue)","Default Title","M16511","878408008252","Weruva","-","-","40","",""], inputValues: ["24","72"] },
  { rowText: ["CIK pouch - Pumpkin Jack Splash (orange)","Default Title","M15135","878408008245","Weruva","-","-","34","",""], inputValues: ["36","84"] },
  { rowText: ["CIK pouch - Pumpkin Lick'n Chicken (yellow)","Default Title","M16512","878408008214","Weruva","-","-","58","",""], inputValues: ["24","72"] },
  { rowText: ["CIKCase - chicken Frick'A Zee - 3oz","Default Title","","878408009020","Weruva","-","-","0","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Double Dip - 2.8oz (red)","Default Title","M16583","878408004728","Weruva","-","-","56","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Fowl Ball - 2.8oz (pink)","Default Title","M16580","878408004681","Weruva","-","-","26","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Funk in the Trunk -  2.8oz (teal)","Default Title","M16581","878408004698","Weruva","-","-","36","",""], inputValues: ["0","0"] },
  { rowText: ["DITK - Lamburgini - 2.8oz (green)","Default Title","M16582","878408004711","Weruva","-","-","40","",""], inputValues: ["0","0"] },
  { rowText: ["DITKCase - Double Dip (red)","Default Title","M27156","878408004667","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Double Dip (red)","Default Title","M27156","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Fowl Ball (pink)","Default Title","M27153","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Fowl Ball (pink)","Default Title","M27153","878408004629","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Funk in the Trunk (teal)","Default Title","M27154","878408004636","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["DITKCase - Funk in the Trunk (teal)","Default Title","M27154","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Lamburgini (green)","Default Title","M27155","","Weruva","-","-","","",""], inputValues: ["1","2"] },
  { rowText: ["DITKCase - Lamburgini (green)","Default Title","M27155","878408004650","Weruva","-","-","0","",""], inputValues: ["",""] },
  { rowText: ["WERCase - CIK - chick magnet (green)","Default Title","M20916","","Weruva","-","-","","",""], inputValues: ["2","3"] },
  { rowText: ["WERCase - CIK - Love me (purp)","Default Title","M20919","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - mack jack (red)","Default Title","M20918","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - One if by land (blue)","Default Title","M20917","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - Pumpkin Jack (org)","Default Title","M20920","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["WERCase - CIK - Pumpkin Lick (yel)","Default Title","M20921","","Weruva","-","-","","",""], inputValues: ["3","6"] },
  { rowText: ["Weruva - Dog - Bed+Bfast - 14oz","Default Title","M15427","878408005220","Weruva","-","-","2","",""], inputValues: ["12","24"] },
  { rowText: ["Weruva - Dog - Cirque De La Mer - 14oz","Default Title","M16587","878408005107","Weruva","-","-","8","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Funky Chunky - 14oz","Default Title","M15424","878408005138","Weruva","-","-","0","",""], inputValues: ["24","36"] },
  { rowText: ["Weruva - Dog - Hot Dayam - 14oz","Default Title","M15422","878408004605","Weruva","-","-","19","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Jammin Salmon - 14oz","Default Title","M16584","878408005190","Weruva","-","-","11","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Marbella Paella - 14oz","Default Title","M16586","878408005213","Weruva","-","-","2","",""], inputValues: ["0","0"] },
  { rowText: ["Weruva - Dog - Paw Licken - 14oz","Default Title","M15423","878408005114","Weruva","-","-","17","",""], inputValues: ["24","36"] },
  { rowText: ["Weruva - Dog - Paw Lickin' Chicken - 5.5oz","Default Title","M14730","878408003110","Weruva","-","-","27","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Peking Ducken - 14oz","Default Title","M16585","878408004582","Weruva","-","-","11","",""], inputValues: ["12","12"] },
  { rowText: ["Weruva - Dog - Steak Frites - 14oz","Default Title","M15426","878408005183","Weruva","-","-","11","",""], inputValues: ["12","24"] },
  { rowText: ["Weruva - Dog - Steak Frites - 5.5oz","Default Title","M14729","878408003189","Weruva","-","-","25","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Wok the dog - 14oz","Default Title","M20290","878408005176","Weruva","-","-","4","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Dog - Wok The Dog - 5.5oz","Default Title","M14731","878408003172","Weruva","-","-","37","",""], inputValues: ["24","24"] },
  { rowText: ["Weruva - Kitten - Chx 3oz (pink)","Default Title","M16548","810028242821","Weruva","-","-","80","",""], inputValues: ["48","144"] },
  { rowText: ["Weruva - Kitten - Chx 3oz (yel)","Default Title","M16550","810028242784","Weruva","-","-","74","",""], inputValues: ["48","144"] },
];

async function main() {
  const bySku = new Map();
  const skippedCase = [];
  const skippedNoSku = [];

  for (const row of scrapedRows) {
    const title = row.rowText[0] || "";
    const sku = (row.rowText[2] || "").trim();
    const [minRaw, maxRaw] = row.inputValues;
    const hasValues = minRaw !== "" || maxRaw !== "";

    if (/case/i.test(title)) {
      skippedCase.push(title);
      continue;
    }
    if (!sku) {
      skippedNoSku.push(title);
      continue;
    }

    const existing = bySku.get(sku);
    if (!existing) {
      bySku.set(sku, { sku, productTitle: title, minRaw, maxRaw, hasValues });
    } else if (!existing.hasValues && hasValues) {
      bySku.set(sku, { sku, productTitle: title, minRaw, maxRaw, hasValues });
    }
  }

  const toWrite = [...bySku.values()].filter(r => r.hasValues);
  const stillBlank = [...bySku.values()].filter(r => !r.hasValues);
  const anomalies = toWrite.filter(r => Number(r.maxRaw) < Number(r.minRaw));

  console.log(`Deduped to ${bySku.size} unique non-case SKUs.`);
  console.log(`${skippedCase.length} case-titled rows skipped (bundled, not needed).`);
  console.log("--- Values that WILL be written ---");
  for (const r of toWrite) {
    console.log(`  ${r.sku}  (${r.productTitle})  ->  min ${r.minRaw || 0} / max ${r.maxRaw || 0}`);
  }
  if (anomalies.length) {
    console.log("--- ANOMALIES: max < min in Stocky itself, writing as-is, verify in Stocky ---");
    anomalies.forEach(r => console.log(`  ${r.sku}  (${r.productTitle})  min ${r.minRaw} / max ${r.maxRaw}`));
  }
  if (stillBlank.length) {
    console.log("--- SKUs with NO value in Stocky (skipped, not zeroed) ---");
    stillBlank.forEach(r => console.log(`  ${r.sku}  (${r.productTitle})`));
  }
  if (skippedNoSku.length) {
    console.log("--- Rows skipped, no SKU at all ---");
    skippedNoSku.forEach(t => console.log(`  ${t}`));
  }

  if (toWrite.length === 0) { console.log("Nothing to write. Exiting."); return; }

  const session = await prisma.session.findFirst({ where: { shop: SHOP, isOnline: false } });
  if (!session?.accessToken) {
    console.error("No offline session token found. Visit the app in Shopify admin first to refresh it.");
    return;
  }

  const skuToVariantId = {};
  let cursor = null;
  let hasMore = true;
  while (hasMore) {
    const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({
        query: `
          query($cursor: String) {
            productVariants(first: 250, after: $cursor, query: "vendor:'Weruva'") {
              pageInfo { hasNextPage endCursor }
              edges { node { id sku } }
            }
          }
        `,
        variables: { cursor },
      }),
    });
    const json = await res.json();
    const page = json.data?.productVariants;
    if (!page) { console.error("GraphQL error:", JSON.stringify(json, null, 2)); break; }
    for (const { node: v } of page.edges) { if (v.sku) skuToVariantId[v.sku.trim()] = v.id; }
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  console.log(`Mapped ${Object.keys(skuToVariantId).length} Weruva variant IDs from Shopify.`);

  let updated = 0, created = 0;
  const unmatched = [];

  for (const row of toWrite) {
    const variantId = skuToVariantId[row.sku];
    if (!variantId) { unmatched.push(row.sku); continue; }
    const minLevel = Number(row.minRaw) || 0;
    const maxLevel = Number(row.maxRaw) || 0;

    const existing = await prisma.minMax.findFirst({ where: { shop: SHOP, variantId, locationId: WILLY_LOCATION_GID } });
    if (existing) {
      await prisma.minMax.update({ where: { id: existing.id }, data: { minLevel, maxLevel, updatedAt: new Date() } });
      updated++;
    } else {
      await prisma.minMax.create({ data: { shop: SHOP, variantId, locationId: WILLY_LOCATION_GID, minLevel, maxLevel, updatedAt: new Date() } });
      created++;
    }
  }

  console.log(`Done. Updated: ${updated}, Created: ${created}`);
  if (unmatched.length) console.log(`Unmatched SKUs (no variant found in Shopify):`, unmatched);
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
